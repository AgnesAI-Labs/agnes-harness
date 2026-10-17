import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  activeRuntimePinId,
  createPackageManager,
  loadPackagePlugins,
  parseSource,
  readLock,
  withLock,
} from '../src/index.js'

const fixture = new URL('./fixtures/runtime-snapshots-v1/home/', import.meta.url)
let root: string
const profile = () => join(root, 'profiles/local-dev')
const stateFile = () => join(profile(), '.agnes-runtime-snapshots.json')
const state = () => JSON.parse(readFileSync(stateFile(), 'utf8'))
const manager = () =>
  createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0', references: async () => [] })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-snapshot-upgrade-'))
  cpSync(fixture, root, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('starts from the real pre-unification store without rewriting pins, records or trust decisions', async () => {
  const before = readFileSync(stateFile(), 'utf8')
  const lock = readFileSync(join(profile(), 'agnes-lock.json'), 'utf8')
  const m = manager()
  await m.recover(profile())
  const inventory = await m.inventory(profile())
  expect(inventory.packages.every((row) => row.trusted && row.blockers.length === 0)).toBe(true)
  const pins = await m.listRuntimePins(profile())
  expect(pins).toHaveLength(3)
  await withLock(profile(), async () => expect(await m.runtimePluginSnapshots(profile())).toHaveLength(2))
  const original = await m.resolveRuntimePin(profile(), { pinId: 'session-original' })
  const module = await import(pathToFileURL(join(original.snapshot.directory, 'index.mjs')).href)
  expect(module.default()).toBe('original-v1-bytes')
  const loaded = await loadPackagePlugins({
    snapshot: original.snapshot,
    generation: 1,
    importModule: async (snapshot) => import(pathToFileURL(join(snapshot.directory, 'index.mjs')).href),
  })
  expect(loaded).toHaveLength(1)
  expect(loaded[0]?.declaration.metadata).toMatchObject({ category: 'example' })
  expect(readFileSync(stateFile(), 'utf8')).toBe(before)
  expect(readFileSync(join(profile(), 'agnes-lock.json'), 'utf8')).toBe(lock)
  expect(original.snapshot.agents).toBeUndefined()
  const resnapshot = await m.pinRuntimeSnapshot(profile(), {
    pinId: 'current-format-reader',
    operationId: 'current-format-reader',
    packageId: 'acme/legacy',
    purpose: 'candidate',
    selector: {
      kind: 'installed',
      expectedIntegrity: original.snapshot.integrity,
      expectedTreeIntegrity: original.snapshot.treeIntegrity,
    },
  })
  expect(resnapshot.snapshot.snapshotId).not.toBe(original.snapshot.snapshotId)
  expect(resnapshot.snapshot.capabilityHash).toBe(original.snapshot.capabilityHash)
  expect(state().snapshots[resnapshot.snapshot.snapshotId].version).toBe(2)
  expect(state().snapshots[original.snapshot.snapshotId]).toEqual(
    JSON.parse(before).snapshots[original.snapshot.snapshotId],
  )
  expect(state().pins['session-original']).toEqual(JSON.parse(before).pins['session-original'])
})

it('writes current snapshots for reviewed updates while the original session resumes its pinned bytes', async () => {
  const m = manager()
  const original = await m.resolveRuntimePin(profile(), { pinId: 'session-original' })
  const old = state()
  const dir = join(root, 'current')
  mkdirSync(dir)
  const launch = { title: { en: 'Work' }, description: { en: 'Work safely' }, preset: 'safe' }
  const application = { id: 'acme', agents: ['acme/legacy#work'], defaultAgent: 'acme/legacy#work' }
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'acme/legacy',
      version: '2.0.0',
      license: 'MIT',
      dependencies: { 'acme/parent': '^1.0.0' },
      exports: './index.mjs',
      agnes: {
        plugins: [{ apiRange: '^4.0.0', id: 'ext:acme/legacy', export: 'runtime', runtime: 'in-process' }],
        bundles: { work: { presets: { safe: { name: 'safe' } }, launch } },
        application,
      },
    }),
  )
  writeFileSync(
    join(dir, 'index.mjs'),
    "export const runtime = { apply() {} }; export default () => 'current-v2-bytes'\n",
  )
  const source = parseSource('file:./current')
  const preview = await m.inspect(profile(), source)
  if (!preview.capabilityHash) throw new Error('missing reviewed capability hash')
  const interrupted = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    references: async () => [],
    checkpoint(point) {
      if (point === 'old-moved') throw new Error('interrupted-upgrade')
    },
  })
  await expect(
    interrupted.update(profile(), 'acme/legacy', source, { expectedIntegrity: preview.integrity }),
  ).rejects.toThrow('interrupted-upgrade')
  await manager().recover(profile())
  expect((await manager().resolveRuntimePin(profile(), { pinId: 'session-original' })).snapshot).toEqual(
    original.snapshot,
  )
  await m.update(profile(), 'acme/legacy', source, { expectedIntegrity: preview.integrity })
  await expect(
    m.pinRuntimeSnapshot(profile(), {
      pinId: 'unreviewed',
      operationId: 'unreviewed',
      packageId: 'acme/legacy',
      purpose: 'candidate',
      selector: {
        kind: 'installed',
        expectedIntegrity: preview.integrity,
        expectedTreeIntegrity: preview.integrity,
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_BLOCKED' })
  await m.trust(profile(), 'acme/legacy', {
    integrity: preview.integrity,
    capabilityHash: preview.capabilityHash,
  })
  const row = (await m.inventory(profile())).packages.find((row) => row.id === 'acme/legacy')
  if (!row?.entry.treeIntegrity) throw new Error('missing updated row')
  const pinId = activeRuntimePinId({ packageId: row.id, integrity: row.entry.integrity })
  const current = await m.pinRuntimeSnapshot(profile(), {
    pinId,
    operationId: pinId,
    packageId: row.id,
    purpose: 'active',
    selector: {
      kind: 'installed',
      expectedIntegrity: row.entry.integrity,
      expectedTreeIntegrity: row.entry.treeIntegrity,
    },
  })
  expect(current.snapshot.agents).toEqual([{ ref: 'acme/legacy#work', launch }])
  expect(current.snapshot.application).toEqual(application)
  await m.enable(profile(), row.id, true)
  expect(
    (await m.runtimePluginSnapshots(profile())).find(
      (source) => source.snapshot.integrity === current.snapshot.integrity,
    )?.snapshot.agents,
  ).toEqual(current.snapshot.agents)
  expect(state().snapshots[current.snapshot.snapshotId].version).toBe(2)
  for (const [id, record] of Object.entries(old.snapshots)) expect(state().snapshots[id]).toEqual(record)
  for (const [id, pin] of Object.entries(old.pins)) expect(state().pins[id]).toEqual(pin)
  const resumed = await manager().resolveRuntimePin(profile(), {
    pinId: 'session-original',
    expectedSnapshotId: original.snapshot.snapshotId,
  })
  expect(resumed).toEqual(original)
  expect((await import(pathToFileURL(join(resumed.snapshot.directory, 'index.mjs')).href)).default()).toBe(
    'original-v1-bytes',
  )
  const tampered = state()
  tampered.snapshots[current.snapshot.snapshotId].agents[0].launch.title.en = 'tampered'
  writeFileSync(stateFile(), JSON.stringify(tampered))
  await expect(manager().listRuntimePins(profile())).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
    detail: { reason: 'snapshot-identity' },
  })
})

it.each(['hash', 'launch', 'shape', 'bytes', 'version', 'lock'])(
  'refuses a tampered historical %s and preserves the evidence',
  async (kind) => {
    const raw = state()
    const snapshotId = raw.pins['session-original'].snapshotId
    const record = raw.snapshots[snapshotId]
    if (kind === 'hash') record.capabilityHash = '0'.repeat(64)
    if (kind === 'launch') record.metadata.launches[0].prompt = 'tampered'
    if (kind === 'shape') record.metadata.category = 'unknown-category'
    if (kind === 'version') record.version = 999
    if (kind === 'lock') {
      const lock = JSON.parse(readFileSync(join(profile(), 'agnes-lock.json'), 'utf8'))
      lock.packages['acme/legacy'].metadata.launches[0].prompt = 'tampered'
      writeFileSync(join(profile(), 'agnes-lock.json'), JSON.stringify(lock))
    } else if (kind === 'bytes') {
      const directory = join(root, 'profiles/local-dev/packages/.runtime-snapshots', snapshotId)
      writeFileSync(join(directory, 'index.mjs'), 'tampered')
    } else writeFileSync(stateFile(), JSON.stringify(raw))
    await expect(manager().inventory(profile())).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  },
)

it('accepts a legacy record without a format marker and does not add one when reading', async () => {
  const raw = state()
  for (const record of Object.values(raw.snapshots) as Record<string, unknown>[]) delete record.version
  writeFileSync(stateFile(), JSON.stringify(raw))
  const before = readFileSync(stateFile(), 'utf8')
  await expect(manager().listRuntimePins(profile())).resolves.toHaveLength(3)
  expect(readFileSync(stateFile(), 'utf8')).toBe(before)
  expect(
    readLock(profile(), { profile: 'local-dev', agnesVersion: '0.1.0' }).packages['acme/legacy']
      ?.trustDecision,
  ).toBeDefined()
})
