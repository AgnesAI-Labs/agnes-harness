import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  activeRuntimePinId,
  createPackageManager,
  emptyLock,
  parseSource,
  readLock,
  writeLock,
} from '../src/index.js'
import { snapshotHash } from '../src/integrity.js'
import { hashDirectory } from '../src/sources.js'

const fixture = new URL('./fixtures/runtime-snapshots-v1/home/', import.meta.url)
let root: string
const profile = () => join(root, 'profiles/local-dev')
const stateFile = () => join(profile(), '.agnes-runtime-snapshots.json')
const state = () => JSON.parse(readFileSync(stateFile(), 'utf8'))
const manager = () =>
  createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0', references: async () => [] })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-snapshot-upgrade-'))
  mkdirSync(profile(), { recursive: true })
  writeLock(profile(), {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
        name,
        { provider: 'local' },
      ]),
    ),
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function currentSnapshot() {
  const m = manager(),
    id = '@acme/binding',
    dir = join(root, 'binding')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      license: 'MIT',
      exports: './index.mjs',
      agnes: { plugins: [{ apiRange: '^5.0.0', export: 'runtime', runtime: 'in-process' }] },
    }),
  )
  writeFileSync(
    join(dir, 'index.mjs'),
    "export const runtime = { apply() {} }; export default () => 'REVIEWED'\n",
  )
  const source = parseSource('file:./binding'),
    preview = await m.inspect(profile(), source)
  if (!preview.capabilityHash) throw new Error('missing reviewed capability hash')
  await m.install(profile(), source, { expectedIntegrity: preview.integrity })
  await m.trust(profile(), id, { integrity: preview.integrity, capabilityHash: preview.capabilityHash })
  await m.enable(profile(), id, true)
  const entry = readLock(profile(), { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[id]
  if (!entry?.treeIntegrity) throw new Error('missing installed tree')
  const pinId = activeRuntimePinId({ packageId: id, integrity: entry.integrity })
  const request = {
    pinId,
    operationId: pinId,
    packageId: id,
    purpose: 'active' as const,
    selector: {
      kind: 'installed' as const,
      expectedIntegrity: entry.integrity,
      expectedTreeIntegrity: entry.treeIntegrity,
    },
  }
  const pin = await m.pinRuntimeSnapshot(profile(), request)
  expect((await m.runtimePluginSnapshots(profile())).find((s) => s.snapshot.packageId === id)?.trusted).toBe(
    true,
  )
  return { id, request, pin }
}

it.each([
  [1, 'npm', false],
  [1, 'npm', true],
  [1, 'file', false],
  [2, 'npm', false],
  [2, 'npm', true],
  [2, 'file', false],
] as const)(
  'refuses a rekeyed v%s archive with substituted %s source (changed bytes: %s)',
  async (version, sourceType, bytes) => {
    const { id, request, pin } = await currentSnapshot()
    const lockBefore = readFileSync(join(profile(), 'agnes-lock.json'), 'utf8')
    const raw = state(),
      record = raw.snapshots[pin.snapshot.snapshotId]
    const archive = pin.snapshot.directory
    if (bytes)
      writeFileSync(
        join(archive, 'index.mjs'),
        "export const runtime = { apply() {} }; export default () => 'UNREVIEWED'\n",
      )
    record.source = parseSource(sourceType === 'npm' ? 'npm:@acme/binding@1.0.0' : 'file:./other-source')
    record.treeIntegrity = hashDirectory(archive, { exclude: [] })
    record.version = version
    record.snapshotId = `sha256-${snapshotHash({
      packageId: id,
      version: record.packageVersion,
      integrity: record.integrity,
      treeIntegrity: record.treeIntegrity,
      capabilityHash: record.capabilityHash,
      ...(version === 2 ? { recordVersion: 2 } : {}),
    })}`
    delete raw.snapshots[pin.snapshot.snapshotId]
    raw.snapshots[record.snapshotId] = record
    raw.pins[request.pinId].snapshotId = record.snapshotId
    if (record.snapshotId !== pin.snapshot.snapshotId)
      renameSync(archive, join(profile(), 'packages/.runtime-snapshots', record.snapshotId))
    writeFileSync(stateFile(), JSON.stringify(raw))
    const current = manager()
    await expect(current.resolveRuntimePin(profile(), { pinId: request.pinId })).rejects.toMatchObject({
      code: 'E_PACKAGE_INTEGRITY',
    })
    await expect(current.runtimePluginSnapshots(profile())).rejects.toMatchObject({
      code: 'E_PACKAGE_INTEGRITY',
    })
    await expect(current.pinRuntimeSnapshot(profile(), request)).rejects.toMatchObject({
      code: 'E_PACKAGE_INTEGRITY',
    })
    await expect(
      current.pinRuntimeSnapshot(profile(), {
        ...request,
        pinId: 'forged-candidate',
        operationId: 'forged-candidate',
        purpose: 'candidate',
        selector: {
          kind: 'snapshot',
          snapshotId: record.snapshotId,
          expectedIntegrity: record.integrity,
          expectedTreeIntegrity: record.treeIntegrity,
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
    expect(readFileSync(join(profile(), 'agnes-lock.json'), 'utf8')).toBe(lockBefore)
  },
)

it.each(['captured', 'category', 'launches', 'kinds', 'unversioned', 'v1'] as const)(
  'refuses the pre-unification %s store without changing records, pins or trust',
  async (kind) => {
    let pinId: string
    if (kind === 'captured') {
      cpSync(fixture, root, { recursive: true })
      pinId = 'session-original'
    } else {
      // Change exactly one current record, so an unrelated bad hash cannot mask the refusal.
      const current = await currentSnapshot()
      pinId = current.request.pinId
      const raw = state()
      const record = raw.snapshots[current.pin.snapshot.snapshotId]
      if (kind === 'category' || kind === 'launches') {
        record.metadata = {
          displayName: 'Synthetic',
          summary: 'Synthetic',
          description: 'Synthetic',
        }
        if (kind === 'category') record.metadata.category = 'tools'
        if (kind === 'launches') record.metadata.launches = []
      }
      if (kind === 'kinds') {
        const file = join(profile(), 'agnes-lock.json')
        const oldLock = JSON.parse(readFileSync(file, 'utf8'))
        delete oldLock.packages[current.id].provides
        oldLock.packages[current.id].kinds = ['tool']
        writeFileSync(file, JSON.stringify(oldLock))
      }
      if (kind === 'unversioned') delete record.version
      if (kind === 'v1') record.version = 1
      if (kind === 'v1' || kind === 'unversioned') {
        record.snapshotId = `sha256-${snapshotHash({ packageId: current.id, version: record.packageVersion, integrity: record.integrity, treeIntegrity: record.treeIntegrity, capabilityHash: record.capabilityHash })}`
        delete raw.snapshots[current.pin.snapshot.snapshotId]
        raw.snapshots[record.snapshotId] = record
        raw.pins[pinId].snapshotId = record.snapshotId
        renameSync(
          current.pin.snapshot.directory,
          join(profile(), 'packages/.runtime-snapshots', record.snapshotId),
        )
      }
      writeFileSync(stateFile(), JSON.stringify(raw))
    }
    const before = readFileSync(stateFile(), 'utf8')
    const lock = readFileSync(join(profile(), 'agnes-lock.json'), 'utf8')
    const m = manager()
    if (kind === 'kinds')
      expect(() => readLock(profile(), { profile: 'local-dev', agnesVersion: '0.1.0' })).toThrow(
        /Retired.*clean home/,
      )
    else await expect(m.listRuntimePins(profile())).rejects.toThrow(/Retired.*clean home/)
    await expect(m.resolveRuntimePin(profile(), { pinId })).rejects.toThrow(/Retired.*clean home/)
    expect(readFileSync(stateFile(), 'utf8')).toBe(before)
    expect(readFileSync(join(profile(), 'agnes-lock.json'), 'utf8')).toBe(lock)
  },
)
