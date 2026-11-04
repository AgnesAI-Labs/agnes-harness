import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openCanonicalFileSync } from '@agnes/system-node'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
import * as sourceModule from '../src/sources.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
const { renameSync: realRenameSync } = await vi.importActual<typeof import('node:fs')>('node:fs')

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
      agnes: {
        plugins: [
          { apiRange: '^5.0.0', export: 'runtime', id: 'ext:acme/runtime-snapshot', runtime: 'in-process' },
        ],
      },
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
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
        name,
        { provider: 'local' },
      ]),
    ),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
})

afterEach(() => {
  vi.mocked(renameSync).mockImplementation(realRenameSync)
  rmSync(root, { recursive: true, force: true })
})

it('lets a worker read validated active snapshots while a package effect owns the lock', async () => {
  const manifestFile = join(sourceDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const launch = { title: { en: 'Work' }, description: { en: 'Work safely' }, preset: 'safe' }
  const application = {
    id: 'acme',
    brand: { name: { en: 'Acme' }, assistantName: { en: 'Ava' } },
    defaultAgent: `${id}#work`,
    agents: [`${id}#work`],
  }
  manifest.agnes.bundles = { work: { presets: { safe: { name: 'safe' } }, launch } }
  manifest.agnes.application = application
  writeFileSync(manifestFile, JSON.stringify(manifest))
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
    const hash = vi.spyOn(sourceModule, 'hashDirectory')
    const asyncHash = vi.spyOn(sourceModule, 'hashDirectoryAsync')
    const [sourcesRead, parallelRead] = await Promise.all([
      m.runtimePluginSnapshots(profile),
      m.runtimePluginSnapshots(profile),
    ])
    expect(parallelRead).toEqual(sourcesRead)
    expect(hash.mock.calls.length).toBe(0)
    expect(asyncHash.mock.calls.length).toBe(2)
    hash.mockRestore()
    asyncHash.mockRestore()
    const sources = sourcesRead
    expect(sources).toHaveLength(1)
    expect(sources[0]?.snapshot.integrity).toBe(selected.integrity)
    expect(sources[0]?.snapshot.agents).toEqual([{ ref: `${id}#work`, launch }])
    expect(sources[0]?.snapshot.application).toEqual(application)
    expect(sources[0]?.snapshot.directory).not.toBe(packageDir(root, 'local-dev', id))
  })
  const stateFile = join(profile, '.agnes-runtime-snapshots.json')
  const original = readFileSync(stateFile, 'utf8')
  const state = JSON.parse(original)
  const snapshotId = Object.keys(state.snapshots)[0]
  if (!snapshotId) throw new Error('missing snapshot metadata fixture')
  state.snapshots[snapshotId].packageVersion = '9.0.0'
  writeFileSync(stateFile, JSON.stringify(state))
  await expect(m.runtimePluginSnapshots(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  writeFileSync(stateFile, original)
  expect((await m.runtimePluginSnapshots(profile))[0]?.snapshot.packageId).toBe(id)
})

it.each(['installed payload', 'snapshot payload', 'snapshot manifest'])(
  'keeps a confirmed %s failure refused by the worker shortcut',
  async (target) => {
    const m = await installTrusted()
    const selected = await identity()
    const pin = await m.pinRuntimeSnapshot(profile, {
      pinId: activeRuntimePinId({ packageId: id, integrity: selected.integrity }),
      operationId: 'enable-v1',
      packageId: id,
      purpose: 'active',
      selector: {
        kind: 'installed',
        expectedIntegrity: selected.integrity,
        expectedTreeIntegrity: selected.treeIntegrity,
      },
    })
    const worker = manager({ settleStoredTrees: true })
    await worker.runtimePluginSnapshots(profile)
    const directory = target.startsWith('installed')
      ? packageDir(root, 'local-dev', id)
      : pin.snapshot.directory
    const file = join(directory, target.endsWith('manifest') ? 'package.json' : 'nested.mjs')
    const original = readFileSync(file, 'utf8'),
      stamp = statSync(file)
    writeFileSync(
      file,
      original.replace(
        target.endsWith('manifest') ? 'MIT' : 'v1',
        target.endsWith('manifest') ? 'ISC' : 'v2',
      ),
    )
    utimesSync(file, stamp.atime, stamp.mtime)
    // Known design limitation: an opted-in read has no observation of in-place edits yet.
    // Fresh admission must discover the edit, and that confirmed refusal must remain authoritative.
    await expect(m.inventory(profile, { fresh: true })).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
    await expect(worker.runtimePluginSnapshots(profile)).rejects.toMatchObject({
      code: 'E_PACKAGE_INTEGRITY',
    })
  },
)

it.each([
  'package update at old-moved',
  'runtime pin at runtime-snapshot-moved',
  'runtime GC at runtime-gc-moved',
])('a lock-free snapshot read inside a %s resolves or reports runtime-source-stale', async (window) => {
  await installTrusted()
  const selected = await identity()
  const request = {
    pinId: 'candidate-v1',
    operationId: 'candidate-v1',
    packageId: id,
    purpose: 'candidate' as const,
    selector: {
      kind: 'installed' as const,
      expectedIntegrity: selected.integrity,
      expectedTreeIntegrity: selected.treeIntegrity,
    },
  }
  // The reader runs synchronously at the writer's checkpoint, as another process would interleave.
  let read: Promise<unknown> | undefined
  const readNow = () => {
    read = manager()
      .runtimePluginSnapshots(profile)
      .then(
        () => null,
        (error: unknown) => error,
      )
  }
  if (window === 'package update at old-moved') {
    writeVersion('2.0.0', 'v2')
    const next = await manager().inspect(profile, source)
    await manager({ checkpoint: (point) => (point === 'old-moved' ? readNow() : undefined) }).update(
      profile,
      id,
      source,
      { expectedIntegrity: next.integrity },
    )
  } else if (window === 'runtime pin at runtime-snapshot-moved') {
    await manager({
      runtimeCheckpoint: (point) => (point === 'runtime-snapshot-moved' ? readNow() : undefined),
    }).pinRuntimeSnapshot(profile, request)
  } else {
    const pin = await manager().pinRuntimeSnapshot(profile, request)
    await manager().releaseRuntimePin(profile, {
      pinId: pin.pinId,
      expectedSnapshotId: pin.snapshot.snapshotId,
    })
    await manager({
      runtimeCheckpoint: (point) => (point === 'runtime-gc-moved' ? readNow() : undefined),
    }).collectRuntimeSnapshots(profile)
  }
  if (!read) throw new Error('the writer never reached its checkpoint')
  const error = await read
  // A legal writer is never reported as tampering; stale is the only transient refusal.
  if (error) expect(error).toMatchObject({ detail: { reason: 'runtime-source-stale' } })
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

it.each([
  { code: 'EPERM', damaged: false, realHandle: true },
  { code: 'EBUSY', damaged: false, realHandle: false },
  { code: 'EIO', damaged: false, realHandle: false },
  { code: 'EPERM', damaged: true, realHandle: false },
])(
  'retains a busy Windows snapshot without hiding damage: $code / $damaged',
  async ({ code, damaged, realHandle }) => {
    const m = await installTrusted()
    const selected = await identity()
    const request = {
      pinId: 'gc-reader',
      operationId: 'gc-reader',
      packageId: id,
      purpose: 'active' as const,
      selector: {
        kind: 'installed' as const,
        expectedIntegrity: selected.integrity,
        expectedTreeIntegrity: selected.treeIntegrity,
      },
    }
    const pin = await m.pinRuntimeSnapshot(profile, request)
    const release = () =>
      m.releaseRuntimePin(profile, {
        pinId: pin.pinId,
        expectedSnapshotId: pin.snapshot.snapshotId,
      })
    await release()
    const data = join(pin.snapshot.directory, 'data.json')
    const original = readFileSync(data, 'utf8')
    const fd = sep === '\\' && realHandle ? openCanonicalFileSync(data) : undefined
    if (fd === undefined)
      vi.mocked(renameSync).mockImplementation((from, to) => {
        // Native real paths may spell the temporary root differently (/var versus /private/var).
        if (basename(String(from)) === pin.snapshot.snapshotId) {
          if (damaged) writeFileSync(data, 'damaged')
          throw Object.assign(new Error('snapshot rename refused'), { code })
        }
        realRenameSync(from, to)
      })
    const journal = join(profile, '.agnes-runtime-transaction.json')
    try {
      if (sep === '\\' && code !== 'EIO') {
        if (damaged) {
          await expect(m.collectRuntimeSnapshots(profile)).rejects.toMatchObject({
            code: 'E_PACKAGE_INTEGRITY',
          })
          expect(existsSync(journal)).toBe(true)
          expect(readFileSync(data, 'utf8')).toBe('damaged')
        } else {
          expect(await m.collectRuntimeSnapshots(profile)).toEqual({
            removed: [],
            retained: [pin.snapshot.snapshotId],
          })
          expect(existsSync(journal)).toBe(false)
        }
      } else {
        await expect(m.collectRuntimeSnapshots(profile)).rejects.toMatchObject({ code })
        expect(existsSync(journal)).toBe(true)
      }
      expect(existsSync(pin.snapshot.directory)).toBe(true)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    vi.mocked(renameSync).mockImplementation(realRenameSync)
    writeFileSync(data, original)
    await m.recover(profile)
    await m.pinRuntimeSnapshot(profile, request)
    expect(await m.collectRuntimeSnapshots(profile)).toEqual({
      removed: [],
      retained: [pin.snapshot.snapshotId],
    })
    await release()
    expect(await m.collectRuntimeSnapshots(profile)).toEqual({
      removed: [pin.snapshot.snapshotId],
      retained: [],
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
    const committed = point === 'runtime-gc-state-written'
    const runtimeRoot = dirname(pin.snapshot.directory)
    const trash = () => readdirSync(runtimeRoot).filter((entry) => entry.startsWith('.trash-'))
    // After commit only the journal's trash remains to delete; a crash part-way leaves it partial.
    if (committed) rmSync(join(runtimeRoot, trash()[0] ?? 'missing-trash', 'data.json'))
    const fresh = manager()
    await fresh.recover(profile)
    expect(trash()).toEqual([])
    expect(existsSync(pin.snapshot.directory)).toBe(!committed)
    expect((await fresh.collectRuntimeSnapshots(profile)).removed).toEqual(
      committed ? [] : [pin.snapshot.snapshotId],
    )
  },
)

it('fails closed and preserves unknown or damaged runtime directories', async () => {
  // An ordinary list may bypass recovery only when even dangling journal entries are absent.
  const journal = join(profile, '.agnes-runtime-transaction.json')
  symlinkSync(join(root, 'missing-journal'), journal, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await expect(manager().inventory(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
    await expect(manager().listRuntimePins(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  } finally {
    unlinkSync(journal)
  }
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
  const second = await m.pinRuntimeSnapshot(profile, {
    pinId: 'another-reader',
    operationId: 'another-reader',
    packageId: id,
    purpose: 'turn',
    selector: {
      kind: 'snapshot',
      snapshotId: pin.snapshot.snapshotId,
      expectedIntegrity: expected.integrity,
      expectedTreeIntegrity: expected.treeIntegrity,
    },
  })
  expect((await m.listRuntimePins(profile)).map((row) => row.snapshot)).toEqual([
    pin.snapshot,
    second.snapshot,
  ])
  const dataFile = join(pin.snapshot.directory, 'data.json'),
    original = readFileSync(dataFile, 'utf8'),
    stamp = statSync(dataFile)
  writeFileSync(dataFile, original.replace('v1-json', 'v2-json'))
  utimesSync(dataFile, stamp.atime, stamp.mtime)
  await expect(m.listRuntimePins(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  for (const requests of [
    [
      {
        pinId: 'active-v1',
        operationId: 'enable-v1',
        packageId: id,
        purpose: 'active' as const,
        selector: {
          kind: 'installed' as const,
          expectedIntegrity: expected.integrity,
          expectedTreeIntegrity: expected.treeIntegrity,
        },
      },
    ],
    [
      {
        pinId: 'fresh-pin',
        operationId: 'fresh-pin',
        packageId: id,
        purpose: 'turn' as const,
        selector: {
          kind: 'snapshot' as const,
          snapshotId: pin.snapshot.snapshotId,
          expectedIntegrity: expected.integrity,
          expectedTreeIntegrity: expected.treeIntegrity,
        },
      },
    ],
  ]) {
    await expect(m.pinRuntimeSnapshots(profile, requests)).rejects.toMatchObject({
      code: 'E_PACKAGE_INTEGRITY',
    })
    await expect(m.pinRuntimeSnapshot(profile, requests[0]!)).rejects.toMatchObject({
      code: 'E_PACKAGE_INTEGRITY',
    })
  }
  // Warm static inspection must never stand in for checking the retained tree's current bytes.
  await expect(m.inventory(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  writeFileSync(dataFile, original)
  utimesSync(dataFile, stamp.atime, stamp.mtime)
  expect((await m.listRuntimePins(profile)).map((row) => row.snapshot)).toEqual([
    pin.snapshot,
    second.snapshot,
  ])
  expect((await m.inventory(profile)).packages[0]?.trusted).toBe(true)
  writeFileSync(join(pin.snapshot.directory, 'tampered'), 'preserve')
  await expect(m.resolveRuntimePin(profile, { pinId: pin.pinId })).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
  })
  expect(readFileSync(join(pin.snapshot.directory, 'tampered'), 'utf8')).toBe('preserve')
  rmSync(join(pin.snapshot.directory, 'tampered'))
  for (const item of [pin, second])
    await m.releaseRuntimePin(profile, { pinId: item.pinId, expectedSnapshotId: item.snapshot.snapshotId })
  expect(await m.listRuntimePins(profile)).toEqual([])
  writeFileSync(dataFile, original.replace('v1-json', 'v2-json'))
  // Unreferenced snapshots remain subject to verification, too.
  await expect(m.listRuntimePins(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  await expect(m.inventory(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  writeFileSync(dataFile, original)
  const unknown = join(dirname(pin.snapshot.directory), 'unknown-directory')
  mkdirSync(unknown)
  await expect(m.listRuntimePins(profile)).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
    detail: { reason: 'unknown-runtime-directory' },
  })
  // With no writer transaction in progress the lock-free reader stays fail-closed too.
  await expect(m.runtimePluginSnapshots(profile)).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
    detail: { reason: 'unknown-runtime-directory' },
  })
  await expect(m.collectRuntimeSnapshots(profile)).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
    detail: { reason: 'unknown-runtime-directory' },
  })
  expect(existsSync(unknown)).toBe(true)
  expect(existsSync(pin.snapshot.directory)).toBe(true)
})

it('hashes known snapshots asynchronously in recovery without a journal and refuses changed or partial trees', async () => {
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
  const directory = realpathSync.native(pin.snapshot.directory)
  const syncHash = vi.spyOn(sourceModule, 'hashDirectory')
  const asyncHash = vi.spyOn(sourceModule, 'hashDirectoryAsync')
  try {
    await m.recover(profile)
    const hashed = (spy: typeof syncHash | typeof asyncHash) =>
      spy.mock.calls.filter(([dir]) => realpathSync.native(dir) === directory).length
    expect(existsSync(join(profile, '.agnes-runtime-transaction.json'))).toBe(false)
    expect([hashed(syncHash), hashed(asyncHash) > 0]).toEqual([0, true])
  } finally {
    syncHash.mockRestore()
    asyncHash.mockRestore()
  }
  const dataFile = join(pin.snapshot.directory, 'data.json'),
    nested = join(pin.snapshot.directory, 'nested.mjs'),
    original = readFileSync(dataFile, 'utf8'),
    stamp = statSync(dataFile)
  // Same size and restored timestamps: only the bytes tell the change.
  writeFileSync(dataFile, original.replace('v1-json', 'v2-json'))
  utimesSync(dataFile, stamp.atime, stamp.mtime)
  await expect(m.recover(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  writeFileSync(dataFile, original)
  utimesSync(dataFile, stamp.atime, stamp.mtime)
  await m.recover(profile)
  const nestedBytes = readFileSync(nested)
  rmSync(nested)
  await expect(m.recover(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  writeFileSync(nested, nestedBytes)
  await m.recover(profile)
  expect((await m.listRuntimePins(profile)).map((row) => row.snapshot)).toEqual([pin.snapshot])
})

it('only exposes a rollback target after verifying the retained previous tree', async () => {
  const m = await installTrusted()
  writeVersion('2.0.0', 'v2')
  const update = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: update.integrity })
  expect((await m.inventory(profile)).packages[0]?.verifiedRollbackTarget?.version).toBe('1.0.0')
  // Only a legacy entry may carry a version/integrity-only previous; a modern one fails closed.
  const complete = readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }),
    stripped = structuredClone(complete)
  delete stripped.packages[id]?.previous?.treeIntegrity
  writeLock(profile, stripped)
  await expect(m.inventory(profile)).rejects.toMatchObject({ detail: { reason: 'previous-incomplete' } })
  writeLock(profile, complete)
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

it('keeps a session turn pin through bookkeeping and locked collection, and refuses corrupt bytes', async () => {
  const m = await installTrusted()
  const v1 = await identity()
  const active = await m.pinRuntimeSnapshot(profile, {
    pinId: 'active-v1',
    operationId: 'active-v1',
    packageId: id,
    purpose: 'active',
    selector: { kind: 'installed', expectedIntegrity: v1.integrity, expectedTreeIntegrity: v1.treeIntegrity },
  })
  const turn = await m.pinRuntimeSnapshot(profile, {
    pinId: 'live-session',
    operationId: 'live-session',
    packageId: id,
    purpose: 'turn',
    selector: {
      kind: 'snapshot',
      snapshotId: active.snapshot.snapshotId,
      expectedIntegrity: v1.integrity,
      expectedTreeIntegrity: v1.treeIntegrity,
    },
  })
  await m.releaseRuntimePins(profile, [
    { pinId: active.pinId, expectedSnapshotId: active.snapshot.snapshotId },
  ])
  expect(await m.runtimePinRecords(profile)).toMatchObject({
    pins: [{ pinId: turn.pinId, purpose: 'turn', snapshotId: turn.snapshot.snapshotId }],
    snapshotIds: [turn.snapshot.snapshotId],
  })
  expect(await m.collectRuntimeSnapshots(profile)).toEqual({
    removed: [],
    retained: [turn.snapshot.snapshotId],
  })
  expect((await m.resolveRuntimePin(profile, { pinId: turn.pinId })).snapshot).toEqual(turn.snapshot)
  const file = join(turn.snapshot.directory, 'nested.mjs')
  const original = readFileSync(file, 'utf8')
  writeFileSync(file, original.replace('v1', 'v2'))
  // Metadata is explicitly not a health verdict. Verified consumers and deletion still fail closed.
  expect((await m.runtimePinRecords(profile)).pins.map((pin) => pin.pinId)).toEqual([turn.pinId])
  await expect(m.resolveRuntimePin(profile, { pinId: turn.pinId })).rejects.toMatchObject({
    code: 'E_PACKAGE_INTEGRITY',
  })
  await expect(m.collectRuntimeSnapshots(profile)).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  expect(existsSync(turn.snapshot.directory)).toBe(true)
  writeFileSync(file, original)
  await m.releaseRuntimePin(profile, { pinId: turn.pinId, expectedSnapshotId: turn.snapshot.snapshotId })
  expect((await m.collectRuntimeSnapshots(profile)).removed).toEqual([turn.snapshot.snapshotId])
})

it('releaseRuntimePins releases a batch in order and keeps earlier releases on a stale pin', async () => {
  const m = await installTrusted()
  const v1 = await identity()
  const active = await m.pinRuntimeSnapshot(profile, {
    pinId: 'active-v1',
    operationId: 'enable-v1',
    packageId: id,
    purpose: 'active',
    selector: { kind: 'installed', expectedIntegrity: v1.integrity, expectedTreeIntegrity: v1.treeIntegrity },
  })
  const snapshotId = active.snapshot.snapshotId
  for (const pinId of ['turn-a', 'turn-b', 'turn-c'])
    await m.pinRuntimeSnapshot(profile, {
      pinId,
      operationId: `op-${pinId}`,
      packageId: id,
      purpose: 'turn',
      selector: {
        kind: 'snapshot',
        snapshotId,
        expectedIntegrity: v1.integrity,
        expectedTreeIntegrity: v1.treeIntegrity,
      },
    })
  const ids = async () => (await m.listRuntimePins(profile)).map((pin) => pin.pinId).sort()

  await expect(
    m.releaseRuntimePins(profile, [
      { pinId: 'turn-a', expectedSnapshotId: snapshotId },
      { pinId: 'turn-b', expectedSnapshotId: `sha256-${'0'.repeat(64)}` },
      { pinId: 'turn-c', expectedSnapshotId: snapshotId },
    ]),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  expect(await ids()).toEqual(['active-v1', 'turn-b', 'turn-c'])

  await m.releaseRuntimePins(profile, [
    { pinId: 'turn-b', expectedSnapshotId: snapshotId },
    { pinId: 'turn-missing', expectedSnapshotId: snapshotId },
    { pinId: 'turn-c', expectedSnapshotId: snapshotId },
  ])
  expect(await ids()).toEqual(['active-v1'])
})

// Batched pins: two installed packages so a batch contains two real snapshot-creating transactions.
const idTwo = 'acme/runtime-snapshot-two'
async function installBoth() {
  const m = await installTrusted(),
    dirTwo = join(root, 'source-two')
  mkdirSync(dirTwo, { recursive: true })
  for (const file of readdirSync(sourceDir))
    writeFileSync(
      join(dirTwo, file),
      readFileSync(join(sourceDir, file), 'utf8').replaceAll('acme/runtime-snapshot', idTwo),
    )
  const sourceTwo = parseSource('file:./source-two'),
    preview = await m.inspect(profile, sourceTwo)
  await m.install(profile, sourceTwo, { expectedIntegrity: preview.integrity })
  const rows = (await m.inventory(profile)).packages
  for (const row of rows)
    if (row.id === idTwo)
      await m.trust(profile, idTwo, { integrity: row.entry.integrity, capabilityHash: row.capabilityHash })
  const request = (packageId: string, pinId: string) => {
    const row = rows.find((candidate) => candidate.id === packageId)
    if (!row?.entry.treeIntegrity) throw new Error('missing package identity')
    return {
      pinId,
      operationId: pinId,
      packageId,
      purpose: 'active' as const,
      selector: {
        kind: 'installed' as const,
        expectedIntegrity: row.entry.integrity,
        expectedTreeIntegrity: row.entry.treeIntegrity,
      },
    }
  }
  return { m, request }
}

it.each([0, 1, 3])('pins a batch of %i requests exactly like sequential pins', async (count) => {
  const { m, request } = await installBoth(),
    // The last request repeats the first pin id, so it must see the state the first pin committed.
    requests = [request(id, 'pin-a'), request(idTwo, 'pin-b'), request(id, 'pin-a')].slice(0, count)
  const sequential = []
  for (const each of requests) sequential.push(await m.pinRuntimeSnapshot(profile, each))
  const sequentialState = await m.listRuntimePins(profile)
  for (const pin of sequentialState)
    await m.releaseRuntimePin(profile, { pinId: pin.pinId, expectedSnapshotId: pin.snapshot.snapshotId })
  await m.collectRuntimeSnapshots(profile)
  expect(await m.listRuntimePins(profile)).toEqual([])
  expect(await m.pinRuntimeSnapshots(profile, requests)).toEqual(sequential)
  expect(await m.listRuntimePins(profile)).toEqual(sequentialState)
})

it('keeps the pins committed before a failing batch member and does not attempt later ones', async () => {
  const { m, request } = await installBoth(),
    bad = request(idTwo, 'pin-b')
  bad.selector.expectedTreeIntegrity = `sha256-${'f'.repeat(64)}`
  await expect(
    m.pinRuntimeSnapshots(profile, [request(id, 'pin-a'), bad, request(id, 'pin-c')]),
  ).rejects.toThrow()
  expect((await m.listRuntimePins(profile)).map((pin) => pin.pinId)).toEqual(['pin-a'])
})

it('recovers a journal left between two batched pins like sequential pins', async () => {
  const { request } = await installBoth()
  let prepared = 0
  const crashing = manager({
    runtimeCheckpoint: (seen) => {
      if (seen === 'runtime-prepared' && ++prepared === 2) throw new Error('crash')
    },
  })
  await expect(
    crashing.pinRuntimeSnapshots(profile, [request(id, 'pin-a'), request(idTwo, 'pin-b')]),
  ).rejects.toThrow('crash')
  expect(existsSync(join(profile, '.agnes-runtime-transaction.json'))).toBe(true)
  const fresh = manager()
  await fresh.recover(profile)
  expect((await fresh.listRuntimePins(profile)).map((pin) => pin.pinId)).toEqual(['pin-a'])
  expect((await fresh.pinRuntimeSnapshots(profile, [request(idTwo, 'pin-b')]))[0]?.pinId).toBe('pin-b')
})

it.each(['single', 'batch'] as const)('rechecks warmed installed bytes before a %s pin', async (kind) => {
  const m = await installTrusted()
  const expected = await identity()
  const file = join(packageDir(root, 'local-dev', id), 'data.json')
  const original = readFileSync(file, 'utf8')
  const stamp = statSync(file)
  writeFileSync(file, original.replace('v1-json', 'v2-json'))
  utimesSync(file, stamp.atime, stamp.mtime)
  const request = {
    pinId: 'tamper-test',
    operationId: 'tamper-test',
    packageId: id,
    purpose: 'active' as const,
    selector: {
      kind: 'installed' as const,
      expectedIntegrity: expected.integrity,
      expectedTreeIntegrity: expected.treeIntegrity,
    },
  }
  await expect(
    kind === 'single' ? m.pinRuntimeSnapshot(profile, request) : m.pinRuntimeSnapshots(profile, [request]),
  ).rejects.toThrow()
  expect(await m.listRuntimePins(profile)).toEqual([])
  expect(readFileSync(file, 'utf8')).toContain('v2-json')
})
