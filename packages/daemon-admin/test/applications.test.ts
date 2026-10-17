import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CompositionSessionStore,
  createConfigurationService,
  resolveComposition,
  resolveProfile,
} from '@agnes/host'
import type { InstalledPackage } from '@agnes/package-manager'
import {
  capabilityHash,
  createPackageManager,
  emptyLock,
  parseSource,
  writeLock,
} from '@agnes/package-manager'
import { afterEach, expect, it } from 'vitest'
import { Applications } from '../src/packages/applications.js'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agh-applications-'))
  homes.push(home)
  const directory = join(home, 'profiles', 'local-dev')
  await mkdir(directory, { recursive: true })
  const config = createConfigurationService({ home, profile: 'local-dev' })
  const make = (id: string): InstalledPackage => ({
    id,
    directory,
    trusted: true,
    enabled: true,
    blockers: [],
    contributions: [],
    verifiedRollbackTarget: null,
    capabilityHash: 'a'.repeat(64),
    entry: {
      version: '1.0.0',
      source: { type: 'file', ref: 'file:./synthetic' },
      integrity: `sha256-${id.repeat(64)}`,
      trust: 'trusted',
      license: 'Apache-2.0',
      state: { installed: '2026-10-18T00:00:00.000Z', trusted: '2026-10-18T00:00:00.000Z', enabled: true },
      previous: null,
      application: { id, brand: { name: { en: id } } },
      dependencies: {},
    },
  })
  let packages = [make('a'), make('b')]
  const applications = new Applications({
    manager: { inventory: async () => ({ profile: 'local-dev', hash: '', packages }) },
    profileDirectory: async () => directory,
    active: async () => true,
    home,
    configuration: () => config,
  })
  const adopt = async (id: string) => {
    const state = await applications.get('local-dev'),
      preview = await applications.preview('local-dev', id)
    return applications.adopt('local-dev', id, state.revision, preview.consentDigest)
  }
  return {
    home,
    directory,
    config,
    applications,
    adopt,
    packages: () => packages,
    replace: (next: InstalledPackage[]) => {
      packages = next
    },
  }
}

it('implements no auto-selection, candidate-only install, explicit switch and unresolved fallback without selecting B', async () => {
  const f = await fixture()
  expect(await f.applications.get('local-dev')).toMatchObject({
    status: 'host',
    selection: null,
    effective: null,
  })
  const a = await f.adopt('a')
  expect(a).toMatchObject({ status: 'active', selection: { packageId: 'a' }, effective: { id: 'a' } })
  expect((await f.applications.get('local-dev')).effective?.id).toBe('a')
  const original = f.packages()
  for (const [reason, replacement] of [
    ['disabled', original.map((p) => (p.id === 'a' ? { ...p, enabled: false } : p))],
    ['untrusted', original.map((p) => (p.id === 'a' ? { ...p, trusted: false } : p))],
    ['removed', original.filter((p) => p.id !== 'a')],
    [
      'package-changed',
      original.map((p) =>
        p.id === 'a' ? { ...p, entry: { ...p.entry, integrity: `sha256-${'c'.repeat(64)}` } } : p,
      ),
    ],
  ] as const) {
    f.replace([...replacement])
    expect(await f.applications.get('local-dev')).toMatchObject({
      status: 'unresolved',
      reason,
      selection: a.selection,
      effective: null,
    })
  }
  f.replace(original)
  expect((await f.applications.get('local-dev')).status).toBe('active')
  expect((await f.adopt('b')).effective?.id).toBe('b')
  expect(await f.applications.clear('local-dev', (await f.config.application()).revision)).toMatchObject({
    status: 'host',
    selection: null,
  })
})

it('binds consent to previewed identity, assets, dependencies and roles, refuses stale CAS, and requires re-trust for brand updates', async () => {
  const f = await fixture()
  const before = await f.applications.preview('local-dev', 'a')
  const original = f.packages()
  const a = original[0]!
  const updated = {
    ...a,
    entry: { ...a.entry, application: { ...a.entry.application!, brand: { title: { en: 'Changed' } } } },
  }
  expect(capabilityHash(updated.entry)).not.toBe(capabilityHash(a.entry))
  f.replace([updated, original[1]!])
  await expect(f.applications.adopt('local-dev', 'a', 0, before.consentDigest)).rejects.toMatchObject({
    data: { reason: 'APPLICATION_PREVIEW_STALE' },
  })
  const next = await f.applications.preview('local-dev', 'a')
  expect(next.consentDigest).not.toBe(before.consentDigest)
  await f.applications.adopt('local-dev', 'a', 0, next.consentDigest)
  await expect(f.applications.clear('local-dev', 0)).rejects.toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
  })
  f.replace([{ ...updated, trusted: false }, original[1]!])
  await expect(f.applications.preview('local-dev', 'a')).rejects.toBeDefined()
  expect((await f.applications.get('local-dev')).status).toBe('unresolved')
})

it('fails closed for missing or undeclared roles, references and changed asset bytes', async () => {
  const f = await fixture(),
    [a, b] = f.packages()
  const invalid = {
    ...a!,
    entry: {
      ...a!.entry,
      application: {
        id: 'a',
        presentation: { roles: { navigation: { packageId: 'b', clientId: 'unknown' } } },
      },
    },
  }
  f.replace([invalid, b!])
  await expect(f.applications.preview('local-dev', 'a')).rejects.toMatchObject({
    data: { reason: 'APPLICATION_ROLE_UNDECLARED' },
  })
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
    'base64',
  )
  await writeFile(join(f.directory, 'mark.png'), bytes)
  const brand = { mark: 'mark.png' }
  f.replace([{ ...a!, entry: { ...a!.entry, application: { id: 'a', brand } } }, b!])
  await f.adopt('a')
  await writeFile(join(f.directory, 'mark.png'), Buffer.alloc(8))
  await expect(f.applications.preview('local-dev', 'a')).rejects.toThrow()
  expect(await f.applications.get('local-dev')).toMatchObject({
    status: 'unresolved',
    effective: null,
    selection: { packageId: 'a' },
  })
  expect(await f.applications.clear('local-dev', (await f.config.application()).revision)).toMatchObject({
    status: 'host',
  })
})

it('switches presentation without changing execution profile, hash, composition tree or saved-session bindings', async () => {
  const f = await fixture()
  const env = {
    platform: { os: 'linux' as const, arch: 'x64', capabilities: {} },
    agnesVersion: '1.4.0',
    now: '2026-10-18',
    homeDir: f.home,
  }
  const resolve = async () =>
    resolveProfile(
      { builtin: 'local-dev', user: { name: 'local-dev', ...(await f.config.profileInput()) } },
      env,
    )
  const before = await resolve(),
    tree = resolveComposition(before)
  const sessions = new CompositionSessionStore(f.directory)
  sessions.pin({ sessionKey: 'old-session', profile: before, tree })
  const binding = sessions.read('old-session')
  for (const id of ['a', 'b']) {
    await f.adopt(id)
    const after = await resolve()
    expect(after).toEqual(before)
    expect(after.hash).toBe(before.hash)
    expect(resolveComposition(after)).toEqual(tree)
    expect(sessions.read('old-session')).toEqual(binding)
  }
  await f.config.saveSessionDefaults({
    revision: (await f.config.application()).revision,
    defaults: { preset: 'standard' },
  })
  expect((await f.config.application()).selection?.packageId).toBe('b')
})

it('binds the dependency permission and role code sources, and rejects the loser of online/offline configuration CAS', async () => {
  const f = await fixture(),
    [a, b] = f.packages()
  const roleClient = {
    kind: 'client' as const,
    id: 'ui-row',
    rowId: 'ext:synthetic/ui',
    path: './client.json',
    client: {
      id: 'ui',
      entry: 'client.js',
      lifetime: 'profile' as const,
      presentationRoles: ['navigation' as const],
    },
  }
  const owner = {
    ...a!,
    contributions: [roleClient],
    entry: {
      ...a!.entry,
      dependencies: { b: '*' },
      application: { id: 'a', presentation: { roles: { navigation: { packageId: 'a', clientId: 'ui' } } } },
    },
  }
  f.replace([owner, b!])
  const preview = await f.applications.preview('local-dev', 'a')
  expect(preview.replacedRoles).toContainEqual(
    expect.objectContaining({ packageId: 'a', clientId: 'ui', entry: 'client.js' }),
  )
  expect(preview.dependencyDiff).toEqual({ status: 'known', added: ['b'], removed: [] })
  f.replace([owner, { ...b!, capabilityHash: 'd'.repeat(64) }])
  expect((await f.applications.preview('local-dev', 'a')).consentDigest).not.toBe(preview.consentDigest)
  f.replace([owner, b!])
  const offline = createConfigurationService({ home: f.home, profile: 'local-dev' })
  const outcomes = await Promise.allSettled([
    f.applications.adopt('local-dev', 'a', 0, preview.consentDigest),
    offline.saveApplication({ revision: 0, selection: null }),
  ])
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
  expect((await f.config.application()).revision).toBe(1)
  expect((await f.config.get()).executionRevision).toBe(0)
})

it('restores the consented transitive closure across upgrades and uninstall, and labels an unavailable baseline unknown', async () => {
  const f = await fixture()
  const a = f.packages()[0],
    b = f.packages()[1]
  if (!a || !b) throw new Error('missing fixture')
  const dependency = (id: string, deps = {}) => ({
    ...b,
    id,
    entry: { ...b.entry, application: { id }, dependencies: deps },
  })
  const x = dependency('x', { z: '*' }),
    z = dependency('z'),
    y = dependency('y', { t: '*' }),
    t = dependency('t')
  f.replace([{ ...a, entry: { ...a.entry, dependencies: { x: '*' } } }, x, z, b, y, t])
  await f.adopt('a')
  const upgraded = {
    ...a,
    entry: { ...a.entry, version: '2.0.0', integrity: 'sha256-' + 'e'.repeat(64), dependencies: { y: '*' } },
  }
  f.replace([upgraded, x, z, b, y, t])
  expect((await f.applications.preview('local-dev', 'a')).dependencyDiff).toEqual({
    status: 'known',
    added: ['t', 'y'],
    removed: ['x', 'z'],
  })
  f.replace([{ ...b, entry: { ...b.entry, dependencies: { y: '*' } } }, y, t])
  expect((await f.applications.preview('local-dev', 'b')).dependencyDiff).toEqual({
    status: 'known',
    added: ['t', 'y'],
    removed: ['x', 'z'],
  })
  const current = await f.config.application()
  if (!current.selection) throw new Error('missing selection')
  const { consentSnapshot: _snapshot, ...selection } = current.selection
  await f.config.saveApplication({ revision: current.revision, selection })
  expect((await f.applications.preview('local-dev', 'b')).dependencyDiff).toEqual({
    status: 'unknown',
    reason: 'previous-consent-unavailable',
  })
})

it('installs, previews and adopts the Acme application through a real locking package manager', async () => {
  const f = await fixture()
  const manager = createPackageManager({ dataDir: join(f.home, 'data'), agnesVersion: '0.1.0' })
  writeLock(f.directory, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((kind) => [
        kind,
        { provider: 'local' },
      ]),
    ),
    policySnapshot: { capabilityCeiling: ['tools', 'ui'], workspacePackages: 'require-project-trust' },
  })
  const source = parseSource(`file:${fileURLToPath(new URL('../../../examples/acme', import.meta.url))}`)
  const inspected = await manager.inspect(f.directory, source)
  expect(inspected.blockers).toEqual([])
  const installed = await manager.install(f.directory, source, { expectedIntegrity: inspected.integrity })
  await manager.trust(f.directory, inspected.id, {
    integrity: installed.integrity,
    capabilityHash: inspected.capabilityHash ?? '',
  })
  await manager.setEnabled(f.directory, inspected.id, true)
  const applications = new Applications({
    manager,
    home: f.home,
    profileDirectory: async () => f.directory,
  })
  expect((await applications.get('local-dev')).status).toBe('host')
  const preview = await applications.preview('local-dev', inspected.id)
  expect(preview.declaration.defaultAgent).toBe('@acme/operations#desk')
  expect(preview.assets.mark).toMatch(/^data:image\/png;base64,/)
  const adopted = await applications.adopt('local-dev', inspected.id, 0, preview.consentDigest)
  expect(adopted).toMatchObject({ status: 'active', effective: { id: 'acme-operations' } })
  expect((await applications.clear('local-dev', adopted.revision)).status).toBe('host')
  const racing = new Applications({
    home: f.home,
    profileDirectory: async () => f.directory,
    manager: {
      async inventory(directory, options) {
        const inventory = await manager.inventory(directory, options)
        await manager.setEnabled(directory, inspected.id, false)
        return inventory
      },
    },
  })
  await expect(
    racing.adopt('local-dev', inspected.id, adopted.revision + 1, preview.consentDigest),
  ).rejects.toMatchObject({ data: { reason: 'APPLICATION_PREVIEW_STALE' } })
  expect((await f.config.application()).selection).toBeNull()
}, 15_000)
