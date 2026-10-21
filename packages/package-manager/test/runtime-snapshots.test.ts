import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { packageByteBinding, packageLockByteBinding } from '../src/byte-verification.js'
import {
  activeRuntimePinId,
  createPackageManager,
  emptyLock,
  type ManagerOptions,
  PackageByteVerification,
  packageDir,
  parseSource,
  RuntimeGenerationSnapshotStore,
  readLock,
  revokePackageByteFailure,
  verifiedDirectoryDigestAsync,
  withLock,
  withPackageVerification,
  writeLock,
} from '../src/index.js'
import * as sourceModule from '../src/sources.js'
import * as treeModule from '../src/tree-identity.js'

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
          { apiRange: '^4.0.0', export: 'runtime', id: 'ext:acme/runtime-snapshot', runtime: 'in-process' },
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

afterEach(() => rmSync(root, { recursive: true, force: true }))

it('persists an integrity failure through the existing revoked grant without waiting on the read lock', async () => {
  await installTrusted()
  const faults: Promise<readonly string[]>[] = []
  const verification = new PackageByteVerification({
    profileDir: profile,
    roots: [root],
    onMismatch: (failure) => {
      faults.push(revokePackageByteFailure(profile, root, failure))
    },
  })
  const m = manager({ byteVerification: verification })
  try {
    await m.inventory(profile)
    const file = join(packageDir(root, 'local-dev', id), 'nested.mjs')
    writeFileSync(file, 'changed bytes')
    await expect(m.inventory(profile)).rejects.toThrow()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(await Promise.all(faults)).toEqual([[id]])
    const lock = readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' })
    expect(lock.packages[id]?.state).toMatchObject({ trusted: null, enabled: false })
    expect(lock.packages[id]?.trustDecision).toBeUndefined()
    // The existing lock reader understands this state without a new quarantine format.
  } finally {
    await verification.close()
  }
})

it('does not revoke a re-trusted grant with a late failure from its previous ABA cycle', async () => {
  const m = await installTrusted(),
    row = (await m.inventory(profile)).packages[0]!
  const failure = {
    directory: row.directory!,
    identity: {
      version: row.entry.version,
      integrity: row.entry.integrity,
      treeIntegrity: row.entry.treeIntegrity!,
      capabilityHash: row.capabilityHash,
      packageId: id,
    },
    binding: packageByteBinding(profile),
    lockBinding: packageLockByteBinding(profile),
  }
  const decision = { integrity: row.entry.integrity, capabilityHash: row.capabilityHash }
  await m.untrust(profile, id, decision)
  await m.trust(profile, id, decision)
  expect(await revokePackageByteFailure(profile, root, failure)).toEqual([])
  expect(
    readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[id]?.state.trusted,
  ).not.toBeNull()
})

it.each(['trust', 'enable', 'update', 'rollback'] as const)(
  'keeps %s fully verified even with a warm frozen identity',
  async (operation) => {
    const m = await installTrusted(),
      row = (await m.inventory(profile)).packages[0]!
    writeVersion('2.0.0', 'v2')
    const preview = await m.inspect(profile, source)
    const verification = new PackageByteVerification({ profileDir: profile, roots: [root], quietMs: 0 })
    try {
      await verification.run(() =>
        withPackageVerification(async () => {
          const expected = { ...row.entry, capabilityHash: row.capabilityHash }
          const frozen = await treeModule.treeIdentity(row.directory!)
          await m.inventory(profile)
          expect(await verification.read(row.directory!, expected)).toBe(row.entry.treeIntegrity)
          expect(await verifiedDirectoryDigestAsync(row.directory!, expected)).toBe(row.entry.treeIntegrity)
          const actual = treeModule.treeIdentity
          vi.spyOn(treeModule, 'treeIdentity').mockImplementation((dir) =>
            dir === row.directory ? Promise.resolve(frozen) : actual(dir),
          )
          writeFileSync(join(row.directory!, 'nested.mjs'), 'BAD')
          const invoke = () =>
            operation === 'trust'
              ? m.trust(profile, id, { integrity: row.entry.integrity, capabilityHash: row.capabilityHash })
              : operation === 'enable'
                ? m.enable(profile, id, true)
                : operation === 'rollback'
                  ? m.rollback(profile, id)
                  : m.update(profile, id, source, { expectedIntegrity: preview.integrity })
          await expect(verification.run(invoke)).rejects.toThrow()
          expect(
            readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[id]?.integrity,
          ).toBe(row.entry.integrity)
        }),
      )
    } finally {
      vi.restoreAllMocks()
      await verification.close()
    }
  },
)

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
  writeFileSync(dataFile, original)
  utimesSync(dataFile, stamp.atime, stamp.mtime)
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
  writeFileSync(dataFile, original)
  const unknown = join(dirname(pin.snapshot.directory), 'unknown-directory')
  mkdirSync(unknown)
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

it('review: install rejects changed source bytes despite a warm byte record and W3 memo', async () => {
  const m = manager(),
    preview = await m.inspect(profile, source)
  const digest = sourceModule.hashDirectory(sourceDir, { exclude: [] })
  const expected = { version: '1.0.0', integrity: digest, treeIntegrity: digest, capabilityHash: '' }
  const verification = new PackageByteVerification({ profileDir: profile, roots: [root], quietMs: 0 })
  try {
    await verification.run(() =>
      withPackageVerification(async () => {
        expect(await verification.read(sourceDir, expected)).toBe(digest)
        expect(await verifiedDirectoryDigestAsync(sourceDir, expected)).toBe(digest)
        const frozen = await treeModule.treeIdentity(sourceDir)
        vi.spyOn(treeModule, 'treeIdentity').mockResolvedValue(frozen)
        writeFileSync(join(sourceDir, 'nested.mjs'), 'changed source bytes')
        await expect(m.install(profile, source, { expectedIntegrity: preview.integrity })).rejects.toThrow()
        expect(
          readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[id],
        ).toBeUndefined()
      }),
    )
  } finally {
    vi.restoreAllMocks()
    await verification.close()
  }
})

it('review: generation publication fully checks a new destination despite frozen source observations', async () => {
  const m = await installTrusted(),
    row = (await m.inventory(profile)).packages[0]!
  const expected = {
    version: row.entry.version,
    integrity: row.entry.integrity,
    treeIntegrity: row.entry.treeIntegrity!,
    capabilityHash: row.capabilityHash,
    packageId: id,
  }
  const verification = new PackageByteVerification({ profileDir: profile, roots: [root], quietMs: 0 })
  const target = buildRuntimeTarget({
    rows: [],
    resources: { mcp: [], skills: {} },
    resourceRevision: 'a'.repeat(64),
    compositeRevision: 'b'.repeat(64),
  })
  const store = new RuntimeGenerationSnapshotStore(profile)
  try {
    await verification.run(() =>
      withPackageVerification(async () => {
        await verification.read(row.directory!, expected)
        await verifiedDirectoryDigestAsync(row.directory!, expected)
        const frozen = await treeModule.treeIdentity(row.directory!)
        vi.spyOn(treeModule, 'treeIdentity').mockResolvedValue(frozen)
        vi.spyOn(treeModule, 'treeIdentitySync').mockReturnValue(frozen)
        writeFileSync(join(row.directory!, 'nested.mjs'), 'changed before copy publication')
        expect(() =>
          store.create(
            target,
            [
              {
                trusted: true,
                generation: 1,
                snapshot: {
                  ...expected,
                  snapshotId: expected.integrity,
                  profile: 'local-dev',
                  directory: row.directory!,
                  contributions: row.contributions,
                },
              },
            ],
            'compat',
          ),
        ).toThrow('E_GENERATION_INTEGRITY')
        expect(readdirSync(store.root)).toEqual([])
      }),
    )
  } finally {
    vi.restoreAllMocks()
    await verification.close()
  }
})

it('review: a warm owner still reads revocation live for current sources and retained pins', async () => {
  const m = await installTrusted(),
    row = (await m.inventory(profile)).packages[0]!
  await m.enable(profile, id, true)
  const pin = await m.pinRuntimeSnapshot(profile, {
    pinId: activeRuntimePinId({ packageId: id, integrity: row.entry.integrity }),
    operationId: 'review-revocation',
    packageId: id,
    purpose: 'active',
    selector: {
      kind: 'installed',
      expectedIntegrity: row.entry.integrity,
      expectedTreeIntegrity: row.entry.treeIntegrity!,
    },
  })
  const verification = new PackageByteVerification({ profileDir: profile, roots: [root], quietMs: 0 })
  const reader = manager({ byteVerification: verification })
  try {
    expect((await reader.runtimePluginSnapshots(profile)).some((s) => s.snapshot.packageId === id)).toBe(true)
    const lock = readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' })
    lock.packages[id]!.state.trusted = null
    delete lock.packages[id]!.trustDecision
    writeLock(profile, lock)
    expect((await reader.runtimePluginSnapshots(profile)).some((s) => s.snapshot.packageId === id)).toBe(
      false,
    )
    expect((await reader.inventory(profile)).packages.find((p) => p.id === id)?.trusted).toBe(false)
    await expect(reader.resolveRuntimePin(profile, { pinId: pin.pinId })).rejects.toMatchObject({
      code: 'E_PACKAGE_STATE',
    })
  } finally {
    await verification.close()
  }
})

it('review: rollback checks the real retained previous bytes despite warm W3 and identity records', async () => {
  const m = await installTrusted()
  writeVersion('2.0.0', 'v2')
  const next = await m.inspect(profile, source)
  await m.update(profile, id, source, { expectedIntegrity: next.integrity })
  const row = (await m.inventory(profile)).packages[0]!,
    previous = row.verifiedRollbackTarget!
  expect(previous.version).toBe('1.0.0')
  const verification = new PackageByteVerification({ profileDir: profile, roots: [root], quietMs: 0 })
  try {
    await verification.run(() =>
      withPackageVerification(async () => {
        expect(await verification.read(previous.directory!, previous)).toBe(previous.treeIntegrity)
        expect(await verifiedDirectoryDigestAsync(previous.directory!, previous)).toBe(previous.treeIntegrity)
        const frozen = await treeModule.treeIdentity(previous.directory!)
        vi.spyOn(treeModule, 'treeIdentity').mockResolvedValue(frozen)
        vi.spyOn(treeModule, 'treeIdentitySync').mockReturnValue(frozen)
        writeFileSync(join(previous.directory!, 'nested.mjs'), 'changed retained previous bytes')
        await expect(m.rollback(profile, id)).rejects.toThrow()
        expect(
          readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages[id]?.integrity,
        ).toBe(next.integrity)
        expect(readFileSync(join(previous.directory!, 'nested.mjs'), 'utf8')).toBe(
          'changed retained previous bytes',
        )
      }),
    )
  } finally {
    vi.restoreAllMocks()
    await verification.close()
  }
})
