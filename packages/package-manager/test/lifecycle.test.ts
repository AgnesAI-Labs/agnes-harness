import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createPackageManager,
  emptyLock,
  type ManagerOptions,
  packageDir,
  parseSource,
  readLock,
  writeLock,
} from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures'),
  id = 'acme/pkg-a',
  source = parseSource('file:./source')
let root: string, profile: string, sourceDir: string
const seams = [
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
]
function manager(extra: Partial<ManagerOptions> = {}) {
  return createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => '2026-09-13T00:00:00Z',
    ...extra,
  })
}
const emptyRefs = async () => []
const load = () => readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' })
async function install(m = manager()) {
  const p = await m.inspect(profile, source)
  await m.install(profile, source, { expectedIntegrity: p.integrity })
  return m
}
async function decision(m = manager()) {
  const row = (await m.inventory(profile)).packages.find((p) => p.id === id)
  if (!row) throw Error('missing')
  return { integrity: row.entry.integrity, capabilityHash: row.capabilityHash }
}
function version(value: string) {
  for (const filename of ['package.json']) {
    const f = join(sourceDir, filename),
      data = JSON.parse(readFileSync(f, 'utf8'))
    data.version = value
    writeFileSync(f, JSON.stringify(data))
  }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-lifecycle-'))
  profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  sourceDir = join(root, 'source')
  cpSync(join(fixtures, 'pkg-a'), sourceDir, { recursive: true })
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(seams.map((n) => [n, '@agnes/base'])),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('uses a stable frozen inventory, exact trust snapshot, desired-only enable, local offline rollback and tombstone', async () => {
  const m = await install(manager({ references: emptyRefs })),
    initial = await m.inventory(profile)
  expect(initial.hash).toBe((await m.inventory(profile)).hash)
  expect(Object.isFrozen(initial.packages[0]?.entry.state)).toBe(true)
  await expect(m.trust(profile, id)).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  await m.trust(profile, id, await decision(m))
  await m.setEnabled(profile, id, true)
  expect((await m.inventory(profile)).packages[0]).toMatchObject({ trusted: true, enabled: true })
  version('2.0.0')
  const p = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: p.integrity })
  expect(load().packages[id]).toMatchObject({ version: '2.0.0', state: { trusted: null, enabled: false } })
  await expect(m.setEnabled(profile, id, true)).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  rmSync(sourceDir, { recursive: true })
  const rolled = await m.rollback(profile, id)
  expect(rolled).toMatchObject({
    version: '1.0.0',
    state: { enabled: false, trusted: null },
  })
  expect((await m.inventory(profile)).packages[0]?.trusted).toBe(false)
  await m.remove(profile, id)
  expect(load().packages[id]).toBeUndefined()
  expect(readdirSync(join(profile, 'packages'))).toEqual([])
  const events = readFileSync(join(profile, '.agnes-package-audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(events.map((e) => e.operation)).toEqual([
    'install',
    'trust',
    'enable',
    'update',
    'rollback',
    'remove',
  ])
  expect(events.at(-1)).toMatchObject({ next: 'removed', actor: 'package-manager', result: 'committed' })
  expect(JSON.stringify(events)).not.toContain(root)
})
it('revokes trust and blocks update or rollback activation from resurrecting the package', async () => {
  const m = await install(manager({ references: emptyRefs }))
  await m.trust(profile, id, await decision(m))
  await m.setEnabled(profile, id, true)
  const trusted = await decision(m)

  await m.untrust(profile, id, trusted)
  expect(load().packages[id]).toMatchObject({ state: { trusted: null, enabled: false } })
  expect((await m.inventory(profile)).packages[0]).toMatchObject({ trusted: false, enabled: false })

  version('2.0.0')
  const target = await m.inspect(profile, source)
  await expect(
    m.update(profile, id, source, {
      expectedIntegrity: target.integrity,
      activation: {
        expectedInstalledIntegrity: trusted.integrity,
        trust: { integrity: target.integrity, capabilityHash: target.capabilityHash ?? '' },
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  await m.update(profile, id, source, { expectedIntegrity: target.integrity })
  const current = await decision(m)
  await expect(
    m.rollback(profile, id, {
      expectedTargetIntegrity: trusted.integrity,
      activation: {
        expectedInstalledIntegrity: current.integrity,
        trust: { integrity: trusted.integrity, capabilityHash: trusted.capabilityHash },
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  expect(load().packages[id]).toMatchObject({ state: { trusted: null, enabled: false } })
})
it('atomically binds installed and target digests when update or rollback also trusts and enables', async () => {
  const m = await install(manager({ references: emptyRefs }))
  const initial = (await m.inventory(profile)).packages[0]
  if (!initial) throw new Error('missing initial package')
  await m.trust(profile, id, {
    integrity: initial.entry.integrity,
    capabilityHash: initial.capabilityHash,
  })
  await m.setEnabled(profile, id, true)

  version('2.0.0')
  const target = await m.inspect(profile, source)
  await expect(
    m.update(profile, id, source, {
      expectedIntegrity: target.integrity,
      activation: {
        expectedInstalledIntegrity: initial.entry.integrity,
        trust: { integrity: target.integrity, capabilityHash: '0'.repeat(64) },
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
  expect(load().packages[id]?.integrity).toBe(initial.entry.integrity)
  const updated = await m.update(profile, id, source, {
    expectedIntegrity: target.integrity,
    activation: {
      expectedInstalledIntegrity: initial.entry.integrity,
      trust: { integrity: target.integrity, capabilityHash: target.capabilityHash ?? '' },
    },
  })
  expect(updated).toMatchObject({
    version: '2.0.0',
    state: { trusted: '2026-09-13T00:00:00Z', enabled: true },
    trustDecision: { integrity: target.integrity, capabilityHash: target.capabilityHash },
  })

  version('3.0.0')
  const third = await m.inspect(profile, source)
  await expect(
    m.update(profile, id, source, {
      expectedIntegrity: third.integrity,
      activation: {
        expectedInstalledIntegrity: initial.entry.integrity,
        trust: { integrity: third.integrity, capabilityHash: third.capabilityHash ?? '' },
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
  expect(load().packages[id]?.integrity).toBe(target.integrity)

  const rolled = await m.rollback(profile, id, {
    expectedTargetIntegrity: initial.entry.integrity,
    activation: {
      expectedInstalledIntegrity: target.integrity,
      trust: { integrity: initial.entry.integrity, capabilityHash: initial.capabilityHash },
    },
  })
  expect(rolled).toMatchObject({
    version: '1.0.0',
    state: { trusted: '2026-09-13T00:00:00Z', enabled: true },
    trustDecision: { integrity: initial.entry.integrity, capabilityHash: initial.capabilityHash },
  })
})

it('rejects stale enable and rollback targets while preserving the current desired state', async () => {
  const m = await install(manager({ references: emptyRefs }))
  const initial = (await m.inventory(profile)).packages[0]
  if (!initial) throw new Error('missing initial package')
  await expect(
    m.setEnabled(profile, id, true, { expectedInstalledIntegrity: `sha256-${'0'.repeat(64)}` }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
  expect(load().packages[id]?.state.enabled).toBe(false)

  version('2.0.0')
  const target = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: target.integrity })
  await expect(
    m.rollback(profile, id, { expectedTargetIntegrity: `sha256-${'0'.repeat(64)}` }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
  expect(load().packages[id]?.integrity).toBe(target.integrity)
})
it.each(['integrity', 'capabilityHash'] as const)(
  'refuses wrong %s and does not allow legacy facade methods to bypass modern trust',
  async (field) => {
    const m = await install(),
      d = await decision(m)
    d[field] = field === 'integrity' ? `sha256-${'0'.repeat(64)}` : '0'.repeat(64)
    await expect(m.trust(profile, id, d)).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
    await expect(m.enable(profile, id, true)).rejects.toMatchObject({ code: 'E_PACKAGE_TRUST' })
    expect(load().packages[id]?.state.trusted).toBeNull()
  },
)
it.each(['disable', 'update', 'rollback', 'remove'] as const)(
  'missing runtime reference authority blocks %s',
  async (operation) => {
    const m = await install(manager({ references: emptyRefs }))
    version('2.0.0')
    const p = await m.inspect(profile, source)
    await m.update(profile, id, source, { expectedIntegrity: p.integrity })
    const unbound = manager(),
      run =
        operation === 'disable'
          ? () => unbound.setEnabled(profile, id, false)
          : operation === 'update'
            ? () => unbound.update(profile, id, source, { expectedIntegrity: p.integrity })
            : () => unbound[operation](profile, id)
    await expect(run()).rejects.toMatchObject({
      code: 'E_PACKAGE_BLOCKED',
      detail: { blockers: [{ code: 'generation', references: ['reference-authority-unavailable'] }] },
    })
    expect(load().packages[id]?.version).toBe('2.0.0')
  },
)
it('blocks dependency/Profile and deployment refs, passing only controlled operation identity', async () => {
  const refs = vi.fn(async () => [{ code: 'deployment' as const, references: ['web'] }]),
    m = await install(manager({ references: refs }))
  const lock = load(),
    entry = lock.packages[id]
  if (!entry) throw Error('missing')
  const dependent = structuredClone(entry)
  delete dependent.contributions
  delete dependent.treeIntegrity
  dependent.dependencies = { [id]: '1.0.0' }
  lock.packages['acme/dependent'] = dependent
  lock.seams.ledger = id
  writeLock(profile, lock)
  await expect(m.remove(profile, id)).rejects.toMatchObject({
    detail: {
      blockers: [
        { code: 'dependency', references: ['acme/dependent'] },
        { code: 'profile', references: ['seam:ledger'] },
        { code: 'deployment', references: ['web'] },
      ],
    },
  })
  expect(refs).toHaveBeenCalledWith('local-dev', id, 'remove', [])
  expect(existsSync(packageDir(root, 'local-dev', id))).toBe(true)
})
it('rejects tree/lock metadata tampering and unknown legacy contribution stays blocked', async () => {
  const m = await install(),
    dir = packageDir(root, 'local-dev', id)
  writeFileSync(join(dir, 'tamper'), 'changed')
  await expect(m.inventory(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  rmSync(join(dir, 'tamper'))
  const lock = load(),
    entry = lock.packages[id]
  if (!entry) throw Error('missing')
  delete entry.contributions
  delete entry.treeIntegrity
  writeLock(profile, lock)
  expect((await m.inventory(profile)).packages[0]?.blockers).toEqual([
    { code: 'unknown-contribution', references: ['static-inventory-migration-required'] },
  ])
})
it('legacy add cannot replace a modern package or overwrite a flattened-ID collision', async () => {
  const m = await install()
  await expect(m.add(profile, source.ref)).rejects.toThrow('digest-bound update')
  const pkgFile = join(sourceDir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  pkg.name = 'acme__pkg-a'
  pkg.agnes = { contributions: [{ kind: 'skill', id: 'acme/skill', path: './index.ts' }] }
  writeFileSync(pkgFile, JSON.stringify(pkg))
  const p = await m.inspect(profile, source)
  await expect(m.install(profile, source, { expectedIntegrity: p.integrity })).rejects.toMatchObject({
    detail: { reason: 'package-path-collision' },
  })
  expect(load().packages[id]?.version).toBe('1.0.0')
})
it('manager recovers a committed update before exposing inventory, without duplicate audit', async () => {
  const m = await install(manager({ references: emptyRefs }))
  version('2.0.0')
  const p = await m.inspect(profile, source)
  const crash = manager({
    references: emptyRefs,
    checkpoint: (point) => {
      if (point === 'lock-written') throw Error('crash')
    },
  })
  await expect(crash.update(profile, id, source, { expectedIntegrity: p.integrity })).rejects.toThrow('crash')
  expect((await m.inventory(profile)).packages[0]?.entry.version).toBe('2.0.0')
  await m.recover(profile)
  expect(readFileSync(join(profile, '.agnes-package-audit.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
})

it('does not apply an extension capability ceiling to a Cordis plugin row', async () => {
  const m = await install()
  await m.trust(profile, id, await decision(m))
  const tightened = manager({ ceiling: [] })
  await tightened.setEnabled(profile, id, true)
  expect((await tightened.inventory(profile)).packages[0]?.blockers).toEqual([])
  expect(load().packages[id]?.state.enabled).toBe(true)
})
it('protects provider adapters even when no external runtime references exist', async () => {
  const m = await install(manager({ references: emptyRefs })),
    lock = load()
  lock.provider.adapters = [id]
  writeLock(profile, lock)
  await expect(m.remove(profile, id)).rejects.toMatchObject({
    detail: { blockers: [{ code: 'profile', references: ['provider.adapter'] }] },
  })
  expect(existsSync(packageDir(root, 'local-dev', id))).toBe(true)
})
it('returns the same public preview hash used by the installed trust decision', async () => {
  const m = manager(),
    p = await m.inspect(profile, source)
  expect(p.capabilityHash).toMatch(/^[a-f0-9]{64}$/)
  await m.install(profile, source, { expectedIntegrity: p.integrity })
  expect((await decision(m)).capabilityHash).toBe(p.capabilityHash)
  await m.trust(profile, id, { integrity: p.integrity, capabilityHash: p.capabilityHash ?? '' })
})
it('keeps missing-profile status compatible and inventory hashes independent of location', async () => {
  const m = await install()
  expect(await m.status(join(root, 'missing'))).toEqual([])
  expect(existsSync(join(root, 'missing'))).toBe(false)
  const p = await m.inventory(profile),
    mirror = join(root, 'mirror')
  mkdirSync(join(mirror, 'profiles'), { recursive: true })
  cpSync(profile, join(mirror, 'profiles', 'local-dev'), { recursive: true })
  const moved = createPackageManager({ dataDir: mirror, agnesVersion: '0.1.0' })
  expect((await moved.inventory(join(mirror, 'profiles', 'local-dev'))).hash).toBe(p.hash)
})

it('the Host read-only lock adapter refuses a changed modern trust snapshot', async () => {
  const { lockState } = await import('../src/index.js'),
    m = await install()
  await m.trust(profile, id, await decision(m))
  const lock = load(),
    entry = lock.packages[id]
  if (!entry) throw Error('missing')
  entry.dependencies['acme/new'] = '1.0.0'
  expect(() => lockState(lock, { profileDir: profile })).toThrow('trust snapshot differs')
})
