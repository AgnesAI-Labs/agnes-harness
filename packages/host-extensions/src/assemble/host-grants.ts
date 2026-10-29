import { existsSync, lstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import type { ResolvedPackage } from '@agnes/host-common/profile/types'
import {
  HOST_CAPABILITY_GRANTS,
  type HostCapabilityGrant,
  type HostGrantDeclaration,
  hashDirectory,
  hashDirectoryAsync,
  RELEASE_HOOK_RANKS,
} from '@agnes/package-manager'
import type { EntryRow } from '@agnes/plugin-runtime/host'
import { EXT_ROW_MOUNT_REVISION } from './ext-rows.js'
import type { PackageModule } from './packages.js'

const empty: HostCapabilityGrant = Object.freeze({})

type PinObservation = { stat?: ReturnType<typeof lstatSync> | undefined; digest?: string | undefined }
const eligible = (packages: readonly ResolvedPackage[], packageId: string) => {
  const p = packages.find((candidate) => candidate.id === packageId)
  return p?.enabled &&
    p.trust === 'builtin' &&
    p.source === 'builtin' &&
    p.integrity === `builtin:${p.version}`
    ? p
    : undefined
}
const observe = (directory: string): PinObservation => {
  const stat = existsSync(directory) ? lstatSync(directory) : undefined
  return { stat, digest: stat ? hashDirectory(directory) : undefined }
}

/** Same assembly-scoped pins as the synchronous entry; large source images yield during hashing. */
export async function pinHostCapabilitiesAsync(...args: Parameters<typeof pinHostCapabilities>) {
  const [packages, directories, , declarations = HOST_CAPABILITY_GRANTS] = args
  const observations = new Map<string, PinObservation>()
  for (const declaration of declarations) {
    const directory = directories.get(declaration.packageId)
    if (!directory || !eligible(packages, declaration.packageId) || observations.has(directory)) continue
    try {
      const stat = await lstat(directory)
      observations.set(directory, { stat, digest: await hashDirectoryAsync(directory) })
    } catch {
      observations.set(directory, {})
    }
  }
  return pinCapabilities(args[0], args[1], args[2], args[3], (directory) => observations.get(directory) ?? {})
}

export function pinHostCapabilities(
  packages: readonly ResolvedPackage[],
  directories: ReadonlyMap<string, string>,
  retained: readonly EntryRow[] = [],
  declarations: readonly HostGrantDeclaration[] = HOST_CAPABILITY_GRANTS,
) {
  return pinCapabilities(packages, directories, retained, declarations, observe)
}

/** Pins are scoped to this assembly and use the existing generation row revision on restore.
 * Code images are supplied only by executable/in-memory Host loaders, never by package exports. */
function pinCapabilities(
  packages: readonly ResolvedPackage[],
  directories: ReadonlyMap<string, string>,
  retained: readonly EntryRow[] = [],
  declarations: readonly HostGrantDeclaration[] = HOST_CAPABILITY_GRANTS,
  observeDirectory: (directory: string) => PinObservation = observe,
) {
  const pins = declarations.flatMap((declaration) => {
    const identity = eligible(packages, declaration.packageId)
    const directory = directories.get(declaration.packageId)
    if (
      !identity?.enabled ||
      identity.trust !== 'builtin' ||
      identity.source !== 'builtin' ||
      identity.integrity !== `builtin:${identity.version}` ||
      !directory
    )
      return []
    let stat: ReturnType<typeof lstatSync> | undefined
    let digest: string | undefined
    try {
      ;({ stat, digest } = observeDirectory(directory))
    } catch {
      // A Host code image may use a mutable data directory. File-backed code still needs a digest.
    }
    const revisions = retained.filter(
      (row) =>
        row.mountRevision === EXT_ROW_MOUNT_REVISION && row.plugin.startsWith(`builtin:${identity.id}/`),
    )
    return [
      {
        declaration,
        identity: Object.freeze({ ...identity }),
        directory,
        digest,
        stat,
        retained: revisions.every(
          (row) => /^sha256-[a-f0-9]{64}$/.test(row.entryRevision) && row.entryRevision === digest,
        ),
      },
    ]
  })
  let modules: ReadonlyMap<string, PackageModule> = new Map()
  let bound = new Map<
    string,
    {
      module: PackageModule
      embedded: PackageModule['embeddedExtensions']
      ecosystem: PackageModule['ecosystem']
      isolated: PackageModule['isolatedEcosystem']
      entry: PackageModule['extensionEntry']
      image: boolean
      factories: NonNullable<PackageModule['ecosystem']>
      isolatedFactories: NonNullable<PackageModule['isolatedEcosystem']>
    }
  >()
  const verified = (owner: string, module: PackageModule | undefined) => {
    const pin = pins.find((p) => p.identity.id === owner)
    const proof = bound.get(owner)
    if (
      !pin ||
      !module ||
      !proof ||
      module.id !== owner ||
      module !== proof.module ||
      module.embeddedExtensions !== proof.embedded ||
      module.ecosystem !== proof.ecosystem ||
      module.isolatedEcosystem !== proof.isolated ||
      module.extensionEntry !== proof.entry ||
      module !== modules.get(owner) ||
      (!proof.image && !pin.retained)
    )
      return undefined
    const current = packages.find((p) => p.id === owner)
    if (
      !current?.enabled ||
      current.trust !== pin.identity.trust ||
      current.source !== pin.identity.source ||
      current.version !== pin.identity.version ||
      current.integrity !== pin.identity.integrity
    )
      return undefined
    // Executable and in-memory Host loaders own code images, not mutable import trees.
    if (proof.image) return pin
    try {
      if (pin.stat) {
        const current = lstatSync(pin.directory)
        if (current.dev !== pin.stat.dev || current.ino !== pin.stat.ino) return undefined
      }
      if (pin.digest ? hashDirectory(pin.directory) !== pin.digest : !module.embeddedExtensions)
        return undefined
    } catch {
      return undefined
    }
    return pin
  }
  return {
    bind(selected: ReadonlyMap<string, PackageModule>) {
      modules = selected
      bound = new Map(
        [...selected].map(([id, module]) => [
          id,
          {
            module,
            embedded: module.embeddedExtensions,
            ecosystem: module.ecosystem,
            isolated: module.isolatedEcosystem,
            entry: module.extensionEntry,
            image: !!module.embeddedExtensions || module.extensionEntry === undefined,
            factories: Object.freeze({ ...module.ecosystem }),
            isolatedFactories: Object.freeze({ ...module.isolatedEcosystem }),
          },
        ]),
      )
    },
    integrity(owner: string) {
      return bound.get(owner)?.image ? undefined : pins.find((p) => p.identity.id === owner)?.digest
    },
    extension(owner: string, id: string, module: PackageModule | undefined): HostCapabilityGrant {
      const pin = verified(owner, module)
      if (module?.ecosystem?.[id] !== bound.get(owner)?.factories[id]) return empty
      if (module?.isolatedEcosystem?.[id] !== bound.get(owner)?.isolatedFactories[id]) return empty
      const hookRank = RELEASE_HOOK_RANKS.get(`ext:${id}`)
      return pin
        ? Object.freeze({
            ...pin.declaration.package,
            ...pin.declaration.extensions[id],
            ...(hookRank === undefined ? {} : { hookRank }),
          })
        : empty
    },
    seam(owner: string, name: string, module: PackageModule | undefined): HostCapabilityGrant {
      if (!pins.find((p) => p.identity.id === owner)?.declaration.seams[name]) return empty
      return verified(owner, module)?.declaration.seams[name] ?? empty
    },
    governance() {
      return pins.flatMap(({ declaration }) =>
        Object.entries(declaration.extensions)
          .filter(([, grant]) => grant.governanceHooks)
          .map(([id]) => id),
      )
    },
  }
}
export type HostCapabilityAuthority = ReturnType<typeof pinHostCapabilities>
