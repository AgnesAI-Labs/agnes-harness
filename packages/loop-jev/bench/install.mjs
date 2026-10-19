// Installs the Jev loop's bundled package into a home the way the Market does: inspect the
// payload the release ships, install it, trust the exact bytes and capability scope, enable it.
// The loop is not part of @agnes/base any more, so a host over a home that has not done this
// reports an unknown plugin row.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createConfigurationService,
  createPlatform,
  dataDir,
  readConfigurationProfileInputs,
  readLock,
  resolveProfile,
} from '@agnes/host'
import {
  createPackageManager,
  isRuntimePackageEligible,
  OPTIONAL_BUNDLED_PACKAGES,
  parseSource,
  snapshotPolicy,
} from '@agnes/package-manager'

const PAYLOAD = OPTIONAL_BUNDLED_PACKAGES.find((item) => item.name === 'jev-loop')

/**
 * A package can only be added to a resolved profile: a fresh home's lock is resolved by its first
 * boot, which is too late for the bench, so resolve the profile the way that boot does and record
 * its policy.
 */
export async function resolveHomeProfile({ home, profile, agnesVersion, cwd }) {
  const profileDir = join(home, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  if (readLock(profileDir, { profile, agnesVersion }).resolvedProfileHash !== null) return
  const configuration = await createConfigurationService({ home, profile }).profileInput()
  const inputs = await readConfigurationProfileInputs({
    home,
    workspaceRoot: cwd,
    profile,
    agnesVersion,
    configuration,
  })
  const resolved = await resolveProfile(inputs, {
    platform: createPlatform().snapshot(),
    agnesVersion,
    now: new Date().toISOString(),
    homeDir: home,
  })
  await snapshotPolicy(profileDir, resolved, agnesVersion)
}

/**
 * Makes sure `home`'s profile has the payload this checkout ships (`@agnes/jev-loop`) installed,
 * trusted and enabled. An older copy left in a reused home is updated to the current bytes, so a
 * bench never measures stale code. Does nothing when the current bytes are already in use. Returns
 * whether it had to install, update or enable it.
 */
export async function ensureJevLoopInstalled({ home, profile, agnesVersion, cwd }) {
  if (!PAYLOAD) throw new Error('the Jev loop is not an optional bundled package of this build')
  const profileDir = join(home, 'profiles', profile)
  await resolveHomeProfile({ home, profile, agnesVersion, cwd })
  // The bench owns this home and no runtime is running over it yet, so nothing references the package.
  const manager = createPackageManager({ dataDir: dataDir(home), agnesVersion, references: async () => [] })
  const find = async () =>
    (await manager.inventory(profileDir, { fresh: true })).packages.find((pkg) => pkg.id === PAYLOAD.id)
  const current = await find()
  const source = parseSource(PAYLOAD.ref)
  const preview = await manager.inspect(profileDir, source)
  if (preview.id !== PAYLOAD.id || preview.blockers.length || !preview.capabilityHash)
    throw new Error(
      `${PAYLOAD.id} cannot be installed into ${profileDir}: ${JSON.stringify(preview.blockers)}`,
    )
  // Compare the bytes, not only the state: eligible means enabled and trusted, not current.
  const stale = current !== undefined && current.entry.integrity !== preview.integrity
  if (current && !stale && isRuntimePackageEligible(current)) return false
  if (!current) await manager.install(profileDir, source, { expectedIntegrity: preview.integrity })
  else if (stale)
    try {
      await manager.update(profileDir, PAYLOAD.id, source, {
        expectedIntegrity: preview.integrity,
        expectedInstalledIntegrity: current.entry.integrity,
      })
    } catch (error) {
      throw new Error(
        `${PAYLOAD.id} in ${profileDir} is not the payload this checkout ships and could not be updated ` +
          `(${error instanceof Error ? error.message : String(error)}); use a fresh --home or remove the package from it`,
        { cause: error },
      )
    }
  await manager.trust(profileDir, PAYLOAD.id, {
    integrity: preview.integrity,
    capabilityHash: preview.capabilityHash,
  })
  await manager.setEnabled(profileDir, PAYLOAD.id, true, { expectedInstalledIntegrity: preview.integrity })
  return true
}
