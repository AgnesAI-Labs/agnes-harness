import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createDeploymentReferences,
  createPackageManager,
  emptyLock,
  hashWorkspace,
  parseSource,
  readLock,
  readSurfaceInstances,
  writeLock,
} from '../src/index.js'

let root: string, profile: string, deploy: string, source: string
const id = 'acme/pkg-a'
const instance = {
  package: id,
  surfaceId: 'dashboard',
  mount: '/dashboard',
  sourceId: 'customer',
  config: { title: 'Public' },
  secrets: { key: 'secret://acme/key' },
  grants: [],
}
const surface = {
  id: 'dashboard',
  apiRange: '*',
  artifact: { kind: 'node', entry: './dist/server.js' },
  healthPath: '/health',
  requires: { services: [] },
}
function save(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value))
}
function manager() {
  return createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    references: createDeploymentReferences({ directories: async () => [deploy], runtime: async () => [] }),
  })
}
async function installed() {
  const m = manager(),
    spec = parseSource('file:./source'),
    preview = await m.inspect(profile, spec)
  await m.install(profile, spec, { expectedIntegrity: preview.integrity })
  const row = (await m.inventory(profile)).packages[0]
  if (!row) throw new Error('missing package')
  await m.trust(profile, id, { integrity: row.entry.integrity, capabilityHash: row.capabilityHash })
  await m.setEnabled(profile, id, true)
  return m
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-surfaces-'))
  profile = join(root, 'profiles/local-dev')
  deploy = join(profile, 'deploy')
  source = join(root, 'source')
  mkdirSync(join(deploy, 'surfaces'), { recursive: true })
  cpSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/pkg-a'), source, { recursive: true })
  mkdirSync(join(source, 'dist'))
  writeFileSync(join(source, 'dist/server.js'), 'throw new Error("must never import")')
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  pkg.agnes = { ...pkg.agnes, surfaces: [surface] }
  save(join(source, 'package.json'), pkg)
  save(join(deploy, 'manifest.json'), {
    id: 'customer',
    version: '1.0.0',
    harnessRange: '*',
    extensions: [],
    profileFragment: 'profile/main.yaml',
    presets: [],
    fixtures: 'fixtures/data',
    surfaces: ['surfaces/main.json'],
  })
  save(join(deploy, 'surfaces/main.json'), instance)
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      [
        'approval',
        'checkpoint',
        'ledger',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
        'platform',
        'harness',
      ].map((name) => [name, '@agnes/base']),
    ),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('retains verified surfaces in preview/inventory without executing entry', async () => {
  const m = await installed(),
    inventory = await m.inventory(profile)
  expect(inventory.packages[0]?.contributions).toContainEqual({
    kind: 'surface',
    id: 'dashboard',
    descriptor: surface,
  })
  expect(Object.isFrozen(readSurfaceInstances(deploy).instances[0]?.instance.config)).toBe(true)
})
it.each(['disable', 'update', 'rollback', 'remove'] as const)(
  'blocks %s through the real PackageManager reference path',
  async (operation) => {
    const m = await installed(),
      before = readFileSync(join(profile, 'agnes-lock.json'), 'utf8')
    if (operation === 'rollback') {
      save(join(deploy, 'surfaces/main.json'), { ...instance, package: 'other' })
      const spec = parseSource('file:./source'),
        p = await m.inspect(profile, spec)
      await m.update(profile, id, spec, { expectedIntegrity: p.integrity })
      save(join(deploy, 'surfaces/main.json'), instance)
    }
    const stable = readFileSync(join(profile, 'agnes-lock.json'), 'utf8')
    let call: Promise<unknown>
    if (operation === 'disable') call = m.setEnabled(profile, id, false)
    else if (operation === 'update') {
      const spec = parseSource('file:./source'),
        p = await m.inspect(profile, spec)
      call = m.update(profile, id, spec, { expectedIntegrity: p.integrity })
    } else call = m[operation](profile, id)
    await expect(call).rejects.toMatchObject({
      detail: {
        blockers: expect.arrayContaining([
          { code: 'deployment', references: ['customer:surfaces/main.json'] },
        ]),
      },
    })
    expect(readFileSync(join(profile, 'agnes-lock.json'), 'utf8')).toBe(stable)
    expect(before).toContain(id)
  },
)
it('re-reads the index and preserves runtime blockers', async () => {
  const refs = createDeploymentReferences({
    directories: async () => [deploy],
    runtime: async () => [{ code: 'generation', references: ['live'] }],
  })
  expect(await refs('local-dev', id, 'remove')).toHaveLength(2)
  save(join(deploy, 'surfaces/main.json'), {
    ...instance,
    package: 'other',
    grants: [{ extension: id, name: 'data.read', range: '*' }],
  })
  expect(await refs('local-dev', id, 'remove', [id])).toHaveLength(2)
  save(join(deploy, 'surfaces/main.json'), { ...instance, package: 'other' })
  expect(await refs('local-dev', id, 'remove')).toEqual([{ code: 'generation', references: ['live'] }])
})
it('checks lock workspace even when the external authority returns no references', async () => {
  const m = await installed(),
    lock = readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' })
  lock.workspace = {
    path: 'deploy',
    hash: hashWorkspace(deploy),
    manifestId: 'customer',
    trustedAt: '2026-09-13T00:00:00Z',
  }
  writeLock(profile, lock)
  const local = createPackageManager({ dataDir: root, agnesVersion: '0.1.0', references: async () => [] })
  await expect(local.remove(profile, id)).rejects.toMatchObject({
    detail: { blockers: [{ code: 'deployment', references: ['customer:surfaces/main.json'] }] },
  })
  save(join(deploy, 'surfaces/main.json'), { ...instance, package: 'other' })
  await expect(local.remove(profile, id)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  expect(await m.inventory(profile)).toBeDefined()
})
it.each(['missing', 'symlink', 'parent-link', 'large', 'invalid'] as const)(
  'fails closed for %s declared instance',
  async (mode) => {
    const file = join(deploy, 'surfaces/main.json')
    if (mode === 'missing') rmSync(file)
    if (mode === 'symlink') {
      rmSync(file)
      save(join(root, 'outside.json'), instance)
      symlinkSync(join(root, 'outside.json'), file)
    }
    if (mode === 'parent-link') {
      rmSync(join(deploy, 'surfaces'), { recursive: true })
      mkdirSync(join(root, 'outside'))
      save(join(root, 'outside/main.json'), instance)
      symlinkSync(
        join(root, 'outside'),
        join(deploy, 'surfaces'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
    }
    if (mode === 'large') writeFileSync(file, ' '.repeat(1048577))
    if (mode === 'invalid') save(file, { ...instance, config: { password: 'bad' } })
    expect(() => readSurfaceInstances(deploy)).toThrow()
  },
)
it.each(['disable', 'remove', 'add'] as const)(
  'also protects configured legacy %s paths',
  async (operation) => {
    const m = manager()
    await m.add(profile, 'file:./source')
    const before = readFileSync(join(profile, 'agnes-lock.json'), 'utf8')
    const call =
      operation === 'disable'
        ? m.enable(profile, id, false)
        : operation === 'remove'
          ? m.remove(profile, id)
          : m.add(profile, 'file:./source')
    await expect(call).rejects.toMatchObject({
      detail: {
        blockers: expect.arrayContaining([
          { code: 'deployment', references: ['customer:surfaces/main.json'] },
        ]),
      },
    })
    expect(readFileSync(join(profile, 'agnes-lock.json'), 'utf8')).toBe(before)
  },
)
