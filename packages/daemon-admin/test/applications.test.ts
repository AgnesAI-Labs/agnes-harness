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
import { type AgentPlan, validatePackageAdminCall } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { createAgentLaunches } from '../src/packages/agent-launches.js'
import { Applications } from '../src/packages/applications.js'
import { contributionProjection } from '../src/packages/contribution-roster.js'
import { requirePackageAdmin } from '../src/packages/permissions.js'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
async function fixture(resolveAgent?: (profile: string, ref: string) => Promise<AgentPlan>) {
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
  const inactive = new Set<string>()
  const applications = new Applications({
    ...(resolveAgent ? { resolveAgent } : {}),
    manager: { inventory: async () => ({ profile: 'local-dev', hash: '', packages }) },
    profileDirectory: async () => directory,
    active: async (_profile, id) => !inactive.has(id),
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
    setActive(id: string, active: boolean) {
      if (active) inactive.delete(id)
      else inactive.add(id)
    },
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
  for (const [workbench, reason] of [
    [
      {
        tabs: [
          {
            id: 'object',
            title: { en: 'Object' },
            order: 0,
            slot: 'workbench.panel',
            view: 'page',
            page: 'a#missing',
          },
        ],
      },
      'APPLICATION_PAGE_UNKNOWN',
    ],
    [
      { actions: [{ id: 'review', title: { en: 'Review' }, prompt: { en: 'Review' }, agent: 'a#missing' }] },
      'APPLICATION_AGENT_UNKNOWN',
    ],
  ] as const) {
    f.replace([
      {
        ...a!,
        entry: { ...a!.entry, application: { id: 'a', workbench: structuredClone(workbench) as never } },
      },
      b!,
    ])
    await expect(f.applications.preview('local-dev', 'a')).rejects.toMatchObject({ data: { reason } })
  }
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
  const roleOwner = f.packages()[1]
  if (!roleOwner) throw new Error('fixture')
  f.replace([f.packages()[0]!, { ...roleOwner, contributions: [roleClient()] }])
  const rolePreview = await f.applications.previewRole('local-dev', 'deliverables', {
    packageId: 'b',
    clientId: 'ui',
  })
  await f.applications.selectRole(
    'local-dev',
    'deliverables',
    { packageId: 'b', clientId: 'ui' },
    (await f.config.application()).revision,
    rolePreview.consentDigest,
  )
  expect(await resolve()).toEqual(before)
  expect((await f.config.get()).executionRevision).toBe(0)
  await f.config.saveSessionDefaults({
    revision: (await f.config.application()).revision,
    defaults: { preset: 'standard' },
  })
  expect((await f.config.application()).roleSelections?.deliverables?.packageId).toBe('b')
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
  const packageDirectory = join(f.home, 'ordinary-application')
  await mkdir(packageDirectory)
  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({ agnes: { hostProvidedExternals: { '@synthetic/sdk': '^1.0.0', b: '*' } } }),
  )
  const owner = {
    ...a!,
    directory: packageDirectory,
    contributions: [roleClient],
    entry: {
      ...a!.entry,
      dependencies: { b: '*', '@synthetic/sdk': '^1.0.0' },
      application: { id: 'a', presentation: { roles: { navigation: { packageId: 'a', clientId: 'ui' } } } },
    },
  }
  f.replace([owner, b!])
  const preview = await f.applications.preview('local-dev', 'a')
  const rolePreview = await f.applications.previewRole('local-dev', 'navigation', {
    packageId: 'a',
    clientId: 'ui',
  })
  for (const dependencies of [preview.dependencies, rolePreview.dependencies]) {
    expect(dependencies).toHaveLength(2)
    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ packageId: 'a' }),
        expect.objectContaining({ packageId: 'b' }),
      ]),
    )
  }
  f.replace([
    { ...owner, entry: { ...owner.entry, dependencies: { ...owner.entry.dependencies, missing: '*' } } },
    b!,
  ])
  for (const operation of [
    () => f.applications.preview('local-dev', 'a'),
    () => f.applications.previewRole('local-dev', 'navigation', { packageId: 'a', clientId: 'ui' }),
  ])
    await expect(operation()).rejects.toMatchObject({ data: { reason: 'APPLICATION_DEPENDENCY_MISSING' } })
  f.replace([owner, b!])
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
  const manager = createPackageManager({
    dataDir: join(f.home, 'data'),
    agnesVersion: '0.1.0',
    references: async () => [],
  })
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

function roleClient(role: 'deliverables' | 'navigation' = 'deliverables', entry = 'client.js') {
  return {
    kind: 'client' as const,
    id: 'ui-row',
    rowId: 'ext:synthetic/ui',
    path: './client.json',
    client: { id: 'ui', entry, lifetime: 'profile' as const, presentationRoles: [role] },
  }
}

it('chooses a community role with the host app, overrides an application, restores its default and recovers all choices', async () => {
  const f = await fixture(),
    [a, b] = f.packages()
  if (!a || !b) throw new Error('fixture')
  const { application: _unused, ...community } = b.entry
  f.replace([
    {
      ...a,
      contributions: [roleClient()],
      entry: {
        ...a.entry,
        application: {
          id: 'a',
          presentation: { roles: { deliverables: { packageId: 'a', clientId: 'ui' } } },
        },
      },
    },
    { ...b, contributions: [roleClient()], entry: community },
  ])
  const preview = await f.applications.previewRole('local-dev', 'deliverables', {
    packageId: 'b',
    clientId: 'ui',
  })
  expect(preview).toMatchObject({
    scope: 'presentation-only-no-execution-change',
    recovery: '/?admin; agh app clear',
  })
  expect(preview.replacedRoles).toContainEqual(
    expect.objectContaining({
      role: 'deliverables',
      visibleParts: ['deliverable-cards', 'deliverables-workbench'],
    }),
  )
  const chosen = await f.applications.selectRole(
    'local-dev',
    'deliverables',
    { packageId: 'b', clientId: 'ui' },
    0,
    preview.consentDigest,
  )
  expect(validatePackageAdminCall('_agnes/v1/applications.get', 'result', chosen).ok).toBe(true)
  const authority = {
    audience: 'admin' as const,
    principalId: 'synthetic-admin',
    clientId: 'connection',
    permissions: ['packages.activate' as const],
  }
  const params = {
    profile: 'local-dev',
    packageId: 'b',
    role: 'deliverables',
    targetClientId: 'ui',
    clientId: 'spoof',
    expectedRevision: chosen.revision,
    consentDigest: preview.consentDigest,
    commandId: 'select-ui',
  }
  expect(validatePackageAdminCall('_agnes/v1/applications.adopt', 'params', params).ok).toBe(true)
  await expect(f.applications.call('_agnes/v1/applications.adopt', params, authority)).rejects.toMatchObject({
    code: expect.any(Number),
  })
  expect(() =>
    requirePackageAdmin('_agnes/v1/applications.adopt', {
      ...authority,
      methods: ['_agnes/v1/applications.get'],
    }),
  ).toThrow()
  await f.applications.call(
    '_agnes/v1/applications.adopt',
    { ...params, clientId: authority.clientId },
    authority,
  )
  const owner = f.packages().find((p) => p.id === 'b')
  if (!owner) throw new Error('fixture')
  const declaration = roleClient().client
  const project = (client = declaration, integrity = owner.entry.integrity) =>
    contributionProjection(
      f.packages().find((p) => p.id === 'b') ?? owner,
      client,
      'owner',
      integrity,
      { profile: 'local-dev', inventory: { profile: 'local-dev', hash: '', packages: f.packages() } },
      'active',
    )
  expect((await project()).presentationRoleBindings?.deliverables).toBe(
    chosen.roleSelections?.deliverables?.bindingDigest,
  )
  expect((await project({ ...declaration, entry: 'different.js' })).presentationRoleBindings).toEqual({})
  expect((await project(declaration, 'different-integrity')).presentationRoleBindings).toEqual({})
  const originalPackages = f.packages()
  f.replace(originalPackages.map((p) => (p.id === 'b' ? { ...p, capabilityHash: 'f'.repeat(64) } : p)))
  expect((await project()).presentationRoleBindings?.deliverables).not.toBe(
    chosen.roleSelections?.deliverables?.bindingDigest,
  )
  f.replace(
    originalPackages.map((p) =>
      p.id === 'b' ? { ...p, entry: { ...p.entry, dependencies: { a: '*' } } } : p,
    ),
  )
  const withDependency = (await project()).presentationRoleBindings?.deliverables
  f.replace(f.packages().map((p) => (p.id === 'a' ? { ...p, capabilityHash: 'e'.repeat(64) } : p)))
  expect((await project()).presentationRoleBindings?.deliverables).not.toBe(withDependency)
  f.replace(originalPackages)
  expect(chosen.status).toBe('host')
  expect(chosen.selection).toBeNull()
  expect(chosen.roles).toContainEqual(
    expect.objectContaining({
      role: 'deliverables',
      source: 'choice',
      status: 'resolved',
      effective: { packageId: 'b', clientId: 'ui' },
    }),
  )
  const adopted = await f.adopt('a')
  expect(adopted.roles).toContainEqual(
    expect.objectContaining({
      role: 'deliverables',
      source: 'choice',
      effective: { packageId: 'b', clientId: 'ui' },
    }),
  )
  const cleared = await f.applications.clear('local-dev', adopted.revision, 'deliverables')
  expect(cleared.roles).toContainEqual(
    expect.objectContaining({
      role: 'deliverables',
      selection: null,
      source: 'application',
      effective: { packageId: 'a', clientId: 'ui' },
    }),
  )
  const selected = await f.applications.selectRole(
    'local-dev',
    'deliverables',
    { packageId: 'b', clientId: 'ui' },
    cleared.revision,
    preview.consentDigest,
  )
  await expect(
    f.applications.selectRole(
      'local-dev',
      'deliverables',
      { packageId: 'b', clientId: 'ui' },
      cleared.revision,
      preview.consentDigest,
    ),
  ).rejects.toMatchObject({ data: { reason: 'CONFIG_REVISION_CONFLICT' } })
  const recovered = await f.applications.clear('local-dev', selected.revision)
  expect(recovered.selection).toBeNull()
  expect(recovered.roleSelections).toBeUndefined()
  expect(recovered.roles?.every((role) => role.selection === null && role.source === 'default')).toBe(true)
})

it('retains unresolved role identity without choosing another plugin and binds declarations, code, dependencies and consent', async () => {
  const f = await fixture(),
    [a, b] = f.packages()
  if (!a || !b) throw new Error('fixture')
  const owner = { ...b, contributions: [roleClient()] }
  const app = {
    ...a,
    contributions: [roleClient()],
    entry: {
      ...a.entry,
      application: { id: 'a', presentation: { roles: { deliverables: { packageId: 'a', clientId: 'ui' } } } },
    },
  }
  f.replace([app, owner])
  await f.adopt('a')
  const preview = await f.applications.previewRole('local-dev', 'deliverables', {
    packageId: 'b',
    clientId: 'ui',
  })
  const selected = await f.applications.selectRole(
    'local-dev',
    'deliverables',
    { packageId: 'b', clientId: 'ui' },
    1,
    preview.consentDigest,
  )
  for (const [reason, next] of [
    ['disabled', [app, { ...owner, enabled: false }]],
    ['untrusted', [app, { ...owner, trusted: false }]],
    ['removed', [app]],
    ['package-changed', [app, { ...owner, entry: { ...owner.entry, integrity: 'new-content' } }]],
    ['declaration-changed', [app, { ...owner, contributions: [roleClient('deliverables', 'different.js')] }]],
  ] as const) {
    f.replace([...next])
    const state = await f.applications.get('local-dev')
    expect(state.roles).toContainEqual(
      expect.objectContaining({
        role: 'deliverables',
        status: 'unresolved',
        reason,
        selection: selected.roleSelections?.deliverables,
        source: 'application',
        effective: { packageId: 'a', clientId: 'ui' },
      }),
    )
  }
  f.replace([app, owner])
  f.setActive('b', false)
  expect((await f.applications.get('local-dev')).roles).toContainEqual(
    expect.objectContaining({
      role: 'deliverables',
      status: 'unresolved',
      reason: 'code-or-references-unavailable',
      source: 'application',
    }),
  )
  f.setActive('b', true)
  f.replace([app, { ...owner, contributions: [roleClient('deliverables', 'different.js')] }])
  await expect(
    f.applications.selectRole(
      'local-dev',
      'deliverables',
      { packageId: 'b', clientId: 'ui' },
      selected.revision,
      preview.consentDigest,
    ),
  ).rejects.toMatchObject({ data: { reason: 'APPLICATION_PREVIEW_STALE' } })
  f.replace([app, owner])
  await expect(
    f.applications.previewRole('local-dev', 'navigation', { packageId: 'b', clientId: 'ui' }),
  ).rejects.toMatchObject({ data: { reason: 'APPLICATION_ROLE_UNDECLARED' } })
  await expect(
    f.applications.previewRole('local-dev', 'deliverables', { packageId: 'missing', clientId: 'ui' }),
  ).rejects.toBeDefined()
  const changedTrust = { ...owner, capabilityHash: 'f'.repeat(64) }
  f.replace([app, changedTrust])
  expect(
    (await f.applications.previewRole('local-dev', 'deliverables', { packageId: 'b', clientId: 'ui' }))
      .consentDigest,
  ).not.toBe(preview.consentDigest)
})

it('retains the reviewed Host launch plans, refuses drift at adoption and keeps presentation active on launch-policy changes', async () => {
  let plan: AgentPlan = {
    ref: 'a#work',
    launch: { title: { en: 'Reviewer' }, description: { en: 'Review' }, preset: 'safe' },
    loop: { id: 'work', version: '1.0.0' },
    bundles: ['a#work'],
    preset: 'safe',
    pages: [],
    digest: 'original',
    compositionHash: 'tree',
    presetHash: 'preset',
    effectivePresetHash: 'effective',
    model: { route: 'demo', model: 'demo' },
    models: {},
    permission: { readOnly: true, tools: ['read'], allow: [], deny: [] },
    sources: [{ id: 'a', version: '1.0.0', integrity: 'hash', source: 'runtime-snapshot' }],
  }
  const f = await fixture(async (profile, ref) => {
    expect(profile).toBe('local-dev')
    expect(ref).toBe(plan.ref)
    return structuredClone(plan)
  })
  const a = f.packages()[0]!
  a.entry.agents = [{ ref: plan.ref, launch: plan.launch }]
  a.entry.application = { ...a.entry.application!, agents: [plan.ref], defaultAgent: plan.ref }
  const preview = await f.applications.preview('local-dev', 'a')
  expect(preview.agentLaunches).toEqual([plan])
  plan = { ...plan, digest: 'new-policy', permission: { ...plan.permission, readOnly: false } }
  await expect(f.applications.adopt('local-dev', 'a', 0, preview.consentDigest)).rejects.toMatchObject({
    data: { reason: 'APPLICATION_PREVIEW_STALE' },
  })
  const current = await f.applications.preview('local-dev', 'a')
  const adopted = await f.applications.adopt('local-dev', 'a', 0, current.consentDigest)
  expect(adopted.selection?.consentSnapshot?.agentLaunches).toEqual([plan])
  plan = { ...plan, digest: 'another-policy' }
  expect((await f.applications.get('local-dev')).status).toBe('active')
})

it('launch-review: LD1 clearing and re-adopting invalidates an earlier direct-launch ticket', async () => {
  const plan = launchReviewPlan()
  const f = await fixture(async () => structuredClone(plan)),
    a = f.packages()[0]!
  a.entry.agents = [{ ref: plan.ref, launch: plan.launch }]
  a.entry.application = { ...a.entry.application!, agents: [plan.ref] }
  const adopted = await f.adopt('a')
  let opened = false
  const facade = createAgentLaunches({
    directory: join(f.home, 'launches'),
    backend: {
      caller: async () => ({
        principal: 'human',
        profile: 'local-dev',
        workspace: '/synthetic',
        activation: 'a1',
      }),
      resolve: async () => structuredClone(plan),
      application: () => f.applications.get('local-dev'),
      open: async () => {
        opened = true
        return 'session'
      },
    },
  })
  const before = (await facade.call({ action: 'prepare', agent: plan.ref })) as {
    consent: string
    launchTicket: string
  }
  expect(before.consent).toBe('covered')
  await f.applications.clear('local-dev', adopted.revision)
  await expect(
    facade.call({ action: 'start', launchTicket: before.launchTicket, operationId: 'while-cleared' }),
  ).rejects.toThrow('STALE')
  const readopted = await f.adopt('a')
  expect(readopted.revision).toBeGreaterThan(adopted.revision)
  expect(((await facade.call({ action: 'prepare', agent: plan.ref })) as { consent: string }).consent).toBe(
    'covered',
  )
  await expect(
    facade.call({ action: 'start', launchTicket: before.launchTicket, operationId: 'old-ticket' }),
  ).rejects.toThrow('STALE')
  expect(opened).toBe(false)
})

function launchReviewPlan(): AgentPlan {
  return {
    ref: 'a#work',
    launch: { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'safe' },
    loop: { id: 'work', version: '1.0.0' },
    bundles: ['a#work'],
    preset: 'safe',
    pages: [],
    digest: 'sha256-private-runtime',
    compositionHash: 'tree',
    presetHash: 'preset',
    effectivePresetHash: 'effective',
    model: { route: 'demo', model: 'demo' },
    models: {},
    permission: { readOnly: true, tools: ['read'], allow: [], deny: [] },
    sources: [{ id: 'a', version: '1.0.0', integrity: 'hash', source: 'runtime-snapshot' }],
  }
}

it.each(['snapshot', 'selection', 'launch-plan'] as const)(
  'launch-review: alteration of the persisted %s cannot manufacture covered consent',
  async (change) => {
    const plan = launchReviewPlan()
    const f = await fixture(async () => structuredClone(plan)),
      a = f.packages()[0]!
    a.entry.agents = [{ ref: plan.ref, launch: plan.launch }]
    a.entry.application = { ...a.entry.application!, agents: [plan.ref] }
    await f.adopt('a')
    const saved = await f.config.application()
    if (change === 'snapshot') saved.selection!.consentSnapshot!.version = 'tampered'
    if (change === 'selection') saved.selection!.consentDigest = 'f'.repeat(64)
    if (change === 'launch-plan')
      saved.selection!.consentSnapshot!.agentLaunches = [{ ...plan, digest: 'tampered' }]
    await f.config.saveApplication(saved)
    const facade = createAgentLaunches({
      directory: join(f.home, 'launches'),
      backend: {
        caller: async () => ({
          principal: 'human',
          profile: 'local-dev',
          workspace: '/synthetic',
          activation: 'a',
        }),
        resolve: async () => structuredClone(plan),
        application: () => f.applications.get('local-dev'),
        open: async () => {
          throw new Error('must not auto-start')
        },
      },
    })
    expect(await facade.call({ action: 'prepare', agent: plan.ref })).toMatchObject({
      consent: 'unavailable',
    })
  },
)
