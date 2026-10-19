import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataDir, initializeHomeLocked } from '@agnes/host'
import { createPackageManager, OPTIONAL_BUNDLED_PACKAGES, parseSource } from '@agnes/package-manager'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { ensureJevLoopInstalled, resolveHomeProfile } from '../bench/install.mjs'

const PROFILE = 'local-dev'
const PACKAGE = '@agnes/jev-loop'
const payloadDirectory = fileURLToPath(
  new URL('../../package-manager/bundled-plugins/jev-loop/', import.meta.url),
)
const agnesVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../cli/package.json', import.meta.url)), 'utf8'),
).version as string

let root: string
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-jev-bench-install-')))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const profileOf = (home: string) => join(home, 'profiles', PROFILE)
const options = (home: string) => ({ home, profile: PROFILE, agnesVersion, cwd: root })
const manager = (home: string) => createPackageManager({ dataDir: dataDir(home), agnesVersion, cwd: root })
const installed = async (home: string) =>
  (await manager(home).inventory(profileOf(home), { fresh: true })).packages.find((pkg) => pkg.id === PACKAGE)

/** A reused home whose copy of the package has other bytes than the shipped payload. */
async function homeWithOlderBuild(name: string, state: 'enabled' | 'installed-only') {
  const home = join(root, name)
  await initializeHomeLocked(home, PROFILE)
  await resolveHomeProfile(options(home))
  const older = join(root, `${name}-older`)
  cpSync(payloadDirectory, older, { recursive: true })
  const entry = join(older, 'index.mjs')
  writeFileSync(entry, `${readFileSync(entry, 'utf8')}\n// older build\n`)
  const pm = manager(home)
  const source = parseSource(`file:./${name}-older`)
  const preview = await pm.inspect(profileOf(home), source)
  await pm.install(profileOf(home), source, { expectedIntegrity: preview.integrity })
  if (state === 'enabled') {
    await pm.trust(profileOf(home), PACKAGE, {
      integrity: preview.integrity,
      capabilityHash: preview.capabilityHash ?? '',
    })
    await pm.setEnabled(profileOf(home), PACKAGE, true, { expectedInstalledIntegrity: preview.integrity })
  }
  expect((await installed(home))?.entry.integrity).toBe(preview.integrity)
  return { home, older: preview.integrity }
}

it('installs the shipped payload into a fresh home and leaves a current copy alone', async () => {
  const home = join(root, 'fresh')
  await initializeHomeLocked(home, PROFILE)
  expect(OPTIONAL_BUNDLED_PACKAGES.some((item) => item.id === PACKAGE)).toBe(true)
  expect(await ensureJevLoopInstalled(options(home))).toBe(true)
  expect(await installed(home)).toMatchObject({ enabled: true, trusted: true })
  expect(await ensureJevLoopInstalled(options(home))).toBe(false)
}, 120_000)

it.each(['enabled', 'installed-only'] as const)(
  'replaces an older build of the package left in a reused home (%s)',
  async (state) => {
    const { home, older } = await homeWithOlderBuild(`reused-${state}`, state)
    // An enabled, trusted old copy used to be kept as it was.
    expect(await ensureJevLoopInstalled(options(home))).toBe(true)
    const row = await installed(home)
    expect(row?.entry.integrity).not.toBe(older)
    expect(readFileSync(join(row?.directory ?? '', 'index.mjs'), 'utf8')).not.toContain('older build')
    expect(row).toMatchObject({ enabled: true, trusted: true })
    expect(await ensureJevLoopInstalled(options(home))).toBe(false)
  },
  120_000,
)
