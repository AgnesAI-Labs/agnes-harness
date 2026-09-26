import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  activeRuntimePinId,
  createPackageManager,
  emptyLock,
  type ManagerOptions,
  packageDir,
  parseSource,
  readLock,
  withLock,
  writeLock,
} from '../src/index.js'

const id = 'acme/runtime-snapshot'
const source = parseSource('file:./source')
let root: string, profile: string, sourceDir: string

function writeVersion(version: string, engine: string): void {
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(
    join(sourceDir, 'package.json'),
    JSON.stringify({
      name: id,
      version,
      license: 'MIT',
      dependencies: {},
      exports: './index.mjs',
      agnes: { plugins: [{ export: 'runtime', id: 'ext:acme/runtime-snapshot', runtime: 'in-process' }] },
    }),
  )
  writeFileSync(
    join(sourceDir, 'index.mjs'),
    "import { engine } from './nested.mjs'\n" +
      "import data from './data.json' with { type: 'json' }\n" +
      'export const runtime = { apply() { return { engine, value: data.value } } }\n' +
      'export default () => ({ engine, value: data.value })\n',
  )
  writeFileSync(join(sourceDir, 'nested.mjs'), `export const engine = ${JSON.stringify(engine)}\n`)
  writeFileSync(join(sourceDir, 'data.json'), JSON.stringify({ value: `${engine}-json` }))
}

function manager(extra: Partial<ManagerOptions> = {}) {
  return createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => '2026-09-13T00:00:00Z',
    references: async () => [],
    ...extra,
  })
}

async function installTrusted() {
  const m = manager(),
    preview = await m.inspect(profile, source)
  await m.install(profile, source, { expectedIntegrity: preview.integrity })
  const row = (await m.inventory(profile)).packages[0]
  if (!row) throw new Error('missing package')
  await m.trust(profile, id, { integrity: row.entry.integrity, capabilityHash: row.capabilityHash })
  return m
}

async function identity() {
  const row = (await manager().inventory(profile)).packages[0]
  if (!row?.entry.treeIntegrity) throw new Error('missing package identity')
  return { integrity: row.entry.integrity, treeIntegrity: row.entry.treeIntegrity }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-中文 runtime-snapshot-'))
  profile = join(root, 'profiles', 'local-dev')
  sourceDir = join(root, 'source')
  mkdirSync(profile, { recursive: true })
  writeVersion('1.0.0', 'v1')
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

it('lets a worker read validated active snapshots while a package effect owns the lock', async () => {
  const m = await installTrusted()
  const selected = await identity()
  const pinId = activeRuntimePinId({ packageId: id, integrity: selected.integrity })
  await m.pinRuntimeSnapshot(profile, {
    pinId,
    operationId: pinId,
    packageId: id,
    purpose: 'active',
    selector: {
      kind: 'installed',
      expectedIntegrity: selected.integrity,
      expectedTreeIntegrity: selected.treeIntegrity,
    },
  })
  await withLock(profile, async () => {
    const sources = await m.runtimePluginSnapshots(profile)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.snapshot.integrity).toBe(selected.integrity)
    expect(sources[0]?.snapshot.directory).not.toBe(packageDir(root, 'local-dev', id))
  })
})

it('publishes a complete transaction journal before prepared without moving the package or lock', async () => {
  const before = readFileSync(join(profile, 'agnes-lock.json'), 'utf8')
  const points: string[] = []
  const m = manager({
    checkpoint(point) {
      points.push(point)
      if (point === 'prepared') {
        const journal = JSON.parse(readFileSync(join(profile, '.agnes-package-transaction.json'), 'utf8'))
        expect(journal).toMatchObject({
          version: 1,
          id,
          operation: 'install',
          old: null,
          next: { version: '1.0.0' },
        })
        expect(existsSync(join(profile, '.agnes-package-transaction.json.tmp'))).toBe(false)
        expect(existsSync(packageDir(root, 'local-dev', id))).toBe(false)
        expect(readFileSync(join(profile, 'agnes-lock.json'), 'utf8')).toBe(before)
        throw new Error('stop-after-prepared')
      }
    },
  })
  const preview = await m.inspect(profile, source)
  await expect(m.install(profile, source, { expectedIntegrity: preview.integrity })).rejects.toThrow(
    'stop-after-prepared',
  )
  expect(points).toEqual(['prepared'])
  expect(readFileSync(join(profile, 'agnes-lock.json'), 'utf8')).toBe(before)
})

it('pins immutable installed/previous/existing snapshots and keeps nested module and JSON behavior', async () => {
  const m = await installTrusted(),
    v1 = await identity(),
    active = await m.pinRuntimeSnapshot(profile, {
      pinId: 'active-v1',
      operationId: 'enable-v1',
      packageId: id,
      purpose: 'active',
      selector: {
        kind: 'installed',
        expectedIntegrity: v1.integrity,
        expectedTreeIntegrity: v1.treeIntegrity,
      },
    })
  expect(
    await m.pinRuntimeSnapshot(profile, {
      pinId: 'active-v1',
      operationId: 'enable-v1',
      packageId: id,
      purpose: 'active',
      selector: {
        kind: 'installed',
        expectedIntegrity: v1.integrity,
        expectedTreeIntegrity: v1.treeIntegrity,
      },
    }),
  ).toEqual(active)
  await expect(
    m.pinRuntimeSnapshot(profile, {
      pinId: 'active-v1',
      operationId: 'different-operation',
      packageId: id,
      purpose: 'active',
      selector: {
        kind: 'snapshot',
        snapshotId: active.snapshot.snapshotId,
        expectedIntegrity: v1.integrity,
        expectedTreeIntegrity: v1.treeIntegrity,
      },
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY', detail: { reason: 'pin-id-reused' } })

  writeVersion('2.0.0', 'v2')
  const update = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: update.integrity })
  const installed = (await m.inventory(profile)).packages[0]
  if (!installed?.entry.treeIntegrity) throw new Error('missing updated package')
  expect(installed.verifiedRollbackTarget).toMatchObject({
    version: '1.0.0',
    integrity: v1.integrity,
    capabilityHash: active.snapshot.capabilityHash,
    treeIntegrity: v1.treeIntegrity,
  })
  // The kept previous version is importable, so it carries its on-disk directory and manifest.
  expect(installed.verifiedRollbackTarget?.directory).toMatch(/\.previous-/)
  expect(installed.verifiedRollbackTarget?.contributions).toEqual(active.snapshot.contributions)
  await m.trust(profile, id, {
    integrity: installed.entry.integrity,
    capabilityHash: installed.capabilityHash,
  })
  const candidate = await m.pinRuntimeSnapshot(profile, {
    pinId: 'candidate-v2',
    operationId: 'update-v2',
    packageId: id,
    purpose: 'candidate',
    selector: {
      kind: 'installed',
      expectedIntegrity: installed.entry.integrity,
      expectedTreeIntegrity: installed.entry.treeIntegrity,
    },
  })
  const rollback = await m.pinRuntimeSnapshot(profile, {
    pinId: 'rollback-v1',
    operationId: 'update-v2',
    packageId: id,
    purpose: 'rollback',
    selector: { kind: 'previous', expectedIntegrity: v1.integrity, expectedTreeIntegrity: v1.treeIntegrity },
  })
  const turn = await m.pinRuntimeSnapshot(profile, {
    pinId: 'turn-v1',
    operationId: 'turn-1',
    packageId: id,
    purpose: 'turn',
    selector: {
      kind: 'snapshot',
      snapshotId: active.snapshot.snapshotId,
      expectedIntegrity: v1.integrity,
      expectedTreeIntegrity: v1.treeIntegrity,
    },
  })
  expect(rollback.snapshot.snapshotId).toBe(active.snapshot.snapshotId)
  expect(turn.snapshot.snapshotId).toBe(active.snapshot.snapshotId)
  writeVersion('3.0.0', 'v3')
  const third = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: third.integrity })
  const run = async (directory: string) =>
    ((await import(pathToFileURL(join(directory, 'index.mjs')).href)) as { default(): unknown }).default()
  expect(await run(active.snapshot.directory)).toEqual({ engine: 'v1', value: 'v1-json' })
  expect(await run(candidate.snapshot.directory)).toEqual({ engine: 'v2', value: 'v2-json' })

  await expect(m.remove(profile, id)).rejects.toMatchObject({
    code: 'E_PACKAGE_BLOCKED',
    detail: { blockers: [{ code: 'generation' }] },
  })
  for (const pin of [candidate, rollback, turn, active])
    await m.releaseRuntimePin(profile, {
      pinId: pin.pinId,
      expectedSnapshotId: pin.snapshot.snapshotId,
    })
  const collected = await m.collectRuntimeSnapshots(profile)
  expect([...collected.removed].sort()).toEqual(
    [active.snapshot.snapshotId, candidate.snapshot.snapshotId].sort(),
  )
  await m.remove(profile, id)
  expect(readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[id]).toBeUndefined()
}, 15_000)

it.each(['runtime-prepared', 'runtime-snapshot-moved', 'runtime-state-written'] as const)(
  'recovers snapshot creation interrupted at %s according to the companion-state commit point',
  async (point) => {
    await installTrusted()
    const expected = await identity(),
      crashing = manager({
        runtimeCheckpoint: (seen) => {
          if (seen === point) throw new Error('crash')
        },
      })
    await expect(
      crashing.pinRuntimeSnapshot(profile, {
        pinId: 'candidate-v1',
        operationId: 'operation-v1',
        packageId: id,
        purpose: 'candidate',
        selector: {
          kind: 'installed',
          expectedIntegrity: expected.integrity,
          expectedTreeIntegrity: expected.treeIntegrity,
        },
      }),
    ).rejects.toThrow('crash')
    const fresh = manager()
    await fresh.recover(profile)
    const committed = point === 'runtime-state-written'
    if (committed)
      expect((await fresh.resolveRuntimePin(profile, { pinId: 'candidate-v1' })).snapshot.integrity).toBe(
        expected.integrity,
      )
    else
      await expect(fresh.resolveRuntimePin(profile, { pinId: 'candidate-v1' })).rejects.toMatchObject({
        code: 'E_PACKAGE_STATE',
      })
  },
)

it.each(['runtime-gc-prepared', 'runtime-gc-moved', 'runtime-gc-state-written'] as const)(
  'recovers collection interrupted at %s without losing a referenced state decision',
  async (point) => {
    const m = await installTrusted(),
      expected = await identity(),
      pin = await m.pinRuntimeSnapshot(profile, {
        pinId: 'candidate-v1',
        operationId: 'operation-v1',
        packageId: id,
        purpose: 'candidate',
        selector: {
          kind: 'installed',
          expectedIntegrity: expected.integrity,
          expectedTreeIntegrity: expected.treeIntegrity,
        },
      })
    await m.releaseRuntimePin(profile, {
      pinId: pin.pinId,
      expectedSnapshotId: pin.snapshot.snapshotId,
    })
    await expect(
      manager({
        runtimeCheckpoint: (seen) => {
          if (seen === point) throw new Error('crash')
        },
      }).collectRuntimeSnapshots(profile),
    ).rejects.toThrow('crash')
    const fresh = manager()
    await fresh.recover(profile)
    const committed = point === 'runtime-gc-state-written'
    expect(existsSync(pin.snapshot.directory)).toBe(!committed)
    expect((await fresh.collectRuntimeSnapshots(profile)).removed).toEqual(
      committed ? [] : [pin.snapshot.snapshotId],
    )
  },
)

it('fails closed and preserves unknown or damaged runtime directories', async () => {
  const m = await installTrusted(),
    expected = await identity(),
    pin = await m.pinRuntimeSnapshot(profile, {
      pinId: 'active-v1',
      operationId: 'enable-v1',
      packageId: id,
      purpose: 'active',
      selector: {
        kind: 'installed',
        expectedIntegrity: expected.integrity,
        expectedTreeIntegrity: expected.treeIntegrity,
      },
    })
  writeFileSync(join(pin.snapshot.directory, 'tampered'), 'preserve')
  await expect(m.resolveRuntimePin(profile, { pinId: pin.pinId })).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
  })
  expect(readFileSync(join(pin.snapshot.directory, 'tampered'), 'utf8')).toBe('preserve')
  rmSync(join(pin.snapshot.directory, 'tampered'))
  const unknown = join(dirname(pin.snapshot.directory), 'unknown-directory')
  mkdirSync(unknown)
  await expect(m.collectRuntimeSnapshots(profile)).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
    detail: { reason: 'unknown-runtime-directory' },
  })
  expect(existsSync(unknown)).toBe(true)
  expect(existsSync(pin.snapshot.directory)).toBe(true)
})

it('only exposes a rollback target after verifying the retained previous tree', async () => {
  const m = await installTrusted()
  writeVersion('2.0.0', 'v2')
  const update = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: update.integrity })
  expect((await m.inventory(profile)).packages[0]?.verifiedRollbackTarget?.version).toBe('1.0.0')
  const packages = join(root, 'profiles', 'local-dev', 'packages'),
    previous = readdirSync(packages).find((entry) => entry.startsWith('.previous-'))
  if (!previous) throw new Error('missing previous package directory')
  const tampered = join(packages, previous, 'tampered')
  writeFileSync(tampered, 'preserve')
  await expect(m.inventory(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  expect(readFileSync(tampered, 'utf8')).toBe('preserve')
})

it('does not resolve a retained pin after its package trust is revoked', async () => {
  const m = await installTrusted()
  const expected = await identity()
  const pin = await m.pinRuntimeSnapshot(profile, {
    pinId: 'candidate-revoked',
    operationId: 'operation-revoked',
    packageId: id,
    purpose: 'candidate',
    selector: {
      kind: 'installed',
      expectedIntegrity: expected.integrity,
      expectedTreeIntegrity: expected.treeIntegrity,
    },
  })
  const lock = readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' })
  const entry = lock.packages[id]
  if (!entry) throw new Error('missing package lock')
  entry.state.trusted = null
  delete entry.trustDecision
  writeLock(profile, lock)
  await expect(m.resolveRuntimePin(profile, { pinId: pin.pinId })).rejects.toMatchObject({
    code: 'E_PACKAGE_STATE',
    detail: { reason: 'package-not-eligible' },
  })
})

it('removes unpinned owned runtime snapshots before deleting package state', async () => {
  const m = await installTrusted(),
    expected = await identity(),
    pin = await m.pinRuntimeSnapshot(profile, {
      pinId: 'candidate-v1',
      operationId: 'operation-v1',
      packageId: id,
      purpose: 'candidate',
      selector: {
        kind: 'installed',
        expectedIntegrity: expected.integrity,
        expectedTreeIntegrity: expected.treeIntegrity,
      },
    })
  await expect(
    m.releaseRuntimePin(profile, {
      pinId: pin.pinId,
      expectedSnapshotId: `sha256-${'0'.repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  await m.releaseRuntimePin(profile, {
    pinId: pin.pinId,
    expectedSnapshotId: pin.snapshot.snapshotId,
  })
  await m.remove(profile, id)
  expect(existsSync(pin.snapshot.directory)).toBe(false)
  expect(readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[id]).toBeUndefined()
})

it('listRuntimePins enumerates every pin regardless of purpose', async () => {
  const m = await installTrusted()
  const v1 = await identity()
  const active = await m.pinRuntimeSnapshot(profile, {
    pinId: 'active-v1',
    operationId: 'enable-v1',
    packageId: id,
    purpose: 'active',
    selector: {
      kind: 'installed',
      expectedIntegrity: v1.integrity,
      expectedTreeIntegrity: v1.treeIntegrity,
    },
  })
  const turn = await m.pinRuntimeSnapshot(profile, {
    pinId: 'turn-v1',
    operationId: 'turn-op',
    packageId: id,
    purpose: 'turn',
    selector: {
      kind: 'snapshot',
      snapshotId: active.snapshot.snapshotId,
      expectedIntegrity: v1.integrity,
      expectedTreeIntegrity: v1.treeIntegrity,
    },
  })

  const all = await m.listRuntimePins(profile)
  expect(all.map((pin) => pin.pinId).sort()).toEqual(['active-v1', 'turn-v1'])
  const byId = new Map(all.map((pin) => [pin.pinId, pin]))
  expect(byId.get('active-v1')).toEqual(active)
  expect(byId.get('turn-v1')).toEqual(turn)

  await m.releaseRuntimePin(profile, {
    pinId: 'turn-v1',
    expectedSnapshotId: turn.snapshot.snapshotId,
  })
  expect((await m.listRuntimePins(profile)).map((pin) => pin.pinId)).toEqual(['active-v1'])
})
