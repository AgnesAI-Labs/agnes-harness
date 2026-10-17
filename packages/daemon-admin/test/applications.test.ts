import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CompositionSessionStore,
  createConfigurationService,
  resolveComposition,
  resolveProfile,
} from '@agnes/host'
import type { InstalledPackage } from '@agnes/package-manager'
import { capabilityHash } from '@agnes/package-manager'
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
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  await writeFile(join(f.directory, 'mark.png'), bytes)
  const brand = { mark: 'mark.png' }
  f.replace([{ ...a!, entry: { ...a!.entry, application: { id: 'a', brand } } }, b!])
  await f.adopt('a')
  await writeFile(join(f.directory, 'mark.png'), Buffer.alloc(8))
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
  expect(preview.dependencyDiff).toEqual({ added: ['b'], removed: [] })
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
