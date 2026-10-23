import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEAM_KINDS } from '@agnes/extension-api/seams'
import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DurableStateError,
  type PinnedSeam,
  type ProcessLiveness,
  RuntimeGenerationSnapshotStore,
} from '../src/runtime-snapshots-generations.js'
import * as sources from '../src/sources.js'
import { hashDirectory } from '../src/sources.js'
import {
  verifiedDirectoryDigest,
  withoutPackageVerification,
  withPackageVerification,
} from '../src/verification-operation.js'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const SELECTIONS = Object.fromEntries(
  SEAM_KINDS.map((kind) => [kind, { provider: `${kind}-provider`, version: '1.0.0' }]),
)
const SEAMS = { formatVersion: 1 as const, selections: SELECTIONS }
const PINS: readonly PinnedSeam[] = [
  {
    kind: 'approval',
    provider: 'approval-provider',
    version: '1.0.0',
    sourcePackage: 'p',
    integrity: 'sha512-x',
  },
]
const digest = (key: string) => createHash('sha256').update(key).digest('hex')

function fixture(options: { liveness?: ProcessLiveness } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agh-generation-state-'))
  homes.push(home)
  const store = new RuntimeGenerationSnapshotStore(home, options)
  const target = buildRuntimeTarget({
    rows: [],
    resources: { mcp: [], skills: {} },
    resourceRevision: 'a'.repeat(64),
    compositeRevision: 'b'.repeat(64),
  })
  const generation = () => store.create(target, [], 'compat', [], undefined, SEAMS)
  const pinFile = (key: string) => join(store.root, 'sessions', `${digest(key)}.json`)
  return { home, store, target, generation, pinFile }
}

const messageOf = (action: () => unknown): string => {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

describe('session pin shape gate', () => {
  it('lists a pin whose content names another key as a located corruption, never as undefined', async () => {
    const { store, generation, pinFile } = fixture()
    const snapshot = generation()
    store.pin('healthy', snapshot.id, PINS)
    mkdirSync(join(store.root, 'sessions'), { recursive: true })
    writeFileSync(
      pinFile('original-key'),
      JSON.stringify({
        formatVersion: 1,
        sessionKey: 'different-key',
        generationId: randomUUID(),
        seams: [],
      }),
    )
    const pins = store.sessions()
    expect(pins.map((pin) => pin.sessionKey)).toEqual(['healthy'])
    expect(pins.every((pin) => pin !== undefined)).toBe(true)
    expect(store.corruptEntries().map((entry) => entry.file)).toEqual([pinFile('original-key')])
    await expect(store.collect(new Set())).resolves.toEqual([])
    expect(existsSync(join(store.root, snapshot.id))).toBe(true)
  })

  it('scans pins and heads afresh so a damaged head is located like a damaged pin', () => {
    const { store, generation, pinFile } = fixture()
    store.pin('healthy', generation().id, PINS)
    expect(store.scanDamage()).toEqual([])
    mkdirSync(join(store.root, 'heads'), { recursive: true })
    const head = join(store.root, 'heads', `${digest('composition')}.json`)
    writeFileSync(head, '{')
    writeFileSync(pinFile('torn'), '{')
    expect(
      store
        .scanDamage()
        .map((entry) => entry.file)
        .sort(),
    ).toEqual([head, pinFile('torn')].sort())
    rmSync(head)
    rmSync(pinFile('torn'))
    expect(store.scanDamage()).toEqual([])
  })

  it.each([
    ['null', 'null'],
    ['no seams', JSON.stringify({ formatVersion: 1, sessionKey: 'k', generationId: randomUUID() })],
    [
      'non-array seams',
      JSON.stringify({ formatVersion: 1, sessionKey: 'k', generationId: randomUUID(), seams: {} }),
    ],
    [
      'null seam element',
      JSON.stringify({ formatVersion: 1, sessionKey: 'k', generationId: randomUUID(), seams: [null] }),
    ],
    ['no format', JSON.stringify({ sessionKey: 'k', generationId: randomUUID(), seams: [] })],
    [
      'bad generation id',
      JSON.stringify({ formatVersion: 1, sessionKey: 'k', generationId: '../x', seams: [] }),
    ],
    [
      'bad loop',
      JSON.stringify({ formatVersion: 1, sessionKey: 'k', generationId: randomUUID(), seams: [], loop: 3 }),
    ],
    ['not json', '{'],
  ])(
    'refuses a damaged pin (%s) with a file-located integrity error and keeps the file',
    (_name, content) => {
      const { store, pinFile } = fixture()
      mkdirSync(join(store.root, 'sessions'), { recursive: true })
      writeFileSync(pinFile('k'), content)
      let caught: unknown
      try {
        store.session('k')
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DurableStateError)
      expect((caught as DurableStateError).code).toBe('E_GENERATION_INTEGRITY')
      expect((caught as DurableStateError).file).toBe(pinFile('k'))
      expect(readFileSync(pinFile('k'), 'utf8')).toBe(content)
      expect(store.sessions()).toEqual([])
      expect(store.corruptEntries()).toHaveLength(1)
    },
  )

  it('keeps a newer-format pin distinct from damage and keeps its generation', async () => {
    const { store, generation, pinFile } = fixture()
    const snapshot = generation()
    mkdirSync(join(store.root, 'sessions'), { recursive: true })
    writeFileSync(
      pinFile('future'),
      JSON.stringify({ formatVersion: 99, sessionKey: 'future', generationId: snapshot.id, extra: 1 }),
    )
    expect(messageOf(() => store.session('future'))).toContain('E_GENERATION_PIN_NEWER')
    expect(store.sessions().map((pin) => pin.generationId)).toEqual([snapshot.id])
    expect(store.corruptEntries()).toEqual([])
    expect(await store.collect(new Set())).toEqual([])
    expect(existsSync(join(store.root, snapshot.id))).toBe(true)
  })

  it('round-trips a valid pin including its loop and resources digest', () => {
    const { store, generation } = fixture()
    const snapshot = generation()
    store.pin('s', snapshot.id, PINS)
    store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    expect(store.session('s')).toMatchObject({ generationId: snapshot.id, seams: PINS, loop: { id: 'loop' } })
  })
})

describe('generation record shape gate', () => {
  it.each(['sync', 'cooperative'] as const)(
    'keeps reads equally strict for private resources after %s creation',
    async (mode) => {
      const { home, store, target } = fixture()
      const resources = join(home, 'resource-source')
      mkdirSync(resources)
      writeFileSync(join(resources, 'content.txt'), 'original')
      const snapshot = await store[mode === 'sync' ? 'create' : 'createAsync'](
        target,
        [],
        'compat',
        [],
        { data: { name: 'fixture' }, directories: [resources] },
        SEAMS,
      )
      await withPackageVerification(async () => {
        expect(await store.readAsync(snapshot.id)).toEqual(store.read(snapshot.id))
      })
      const file = join(store.root, snapshot.id, 'resources', '0', 'content.txt')
      const before = statSync(file)
      writeFileSync(file, 'modified')
      utimesSync(file, before.atime, before.mtime)
      // Listing historical ownership is not an archive-health verdict or executable source.
      expect(store.describe(snapshot.id)).toEqual({ id: snapshot.id, packages: snapshot.packages })
      await withPackageVerification(async () => {
        expect(() => store.read(snapshot.id)).toThrow('E_GENERATION_RESOURCE_MISSING')
        await expect(store.readAsync(snapshot.id)).rejects.toThrow('E_GENERATION_RESOURCE_MISSING')
      })
      writeFileSync(file, 'original')
      await withPackageVerification(async () => {
        expect(await store.readAsync(snapshot.id)).toEqual(snapshot)
        await withoutPackageVerification(async () => {
          writeFileSync(file, 'modified')
        })
        await expect(store.readAsync(snapshot.id)).rejects.toThrow('E_GENERATION_RESOURCE_MISSING')
      })
    },
  )

  const corrupted = (mutate: (record: Record<string, unknown>) => unknown) => {
    const { store, generation } = fixture()
    const snapshot = generation()
    const file = join(store.root, snapshot.id, 'generation.json')
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify(mutate(record)))
    expect(() => store.describe(snapshot.id)).toThrow()
    let caught: unknown
    try {
      store.read(snapshot.id)
    } catch (error) {
      caught = error
    }
    return { caught, file }
  }

  it.each([
    ['null record', () => null],
    ['null package', (record: Record<string, unknown>) => ({ ...record, packages: [null] })],
    ['null source', (record: Record<string, unknown>) => ({ ...record, sources: [null] })],
    [
      'untrusted source',
      (record: Record<string, unknown>) => ({ ...record, sources: [{ trusted: false, snapshot: {} }] }),
    ],
    [
      'empty seam selections',
      (record: Record<string, unknown>) => ({ ...record, seams: { formatVersion: 1, selections: {} } }),
    ],
    [
      'one seam kind missing',
      (record: Record<string, unknown>) => ({
        ...record,
        seams: { formatVersion: 1, selections: { ...SELECTIONS, approval: undefined } },
      }),
    ],
    ['bad artifact', (record: Record<string, unknown>) => ({ ...record, artifact: 7 })],
  ])('reports %s as a located integrity error', (_name, mutate) => {
    const { caught, file } = corrupted(mutate as never)
    expect(caught).toBeInstanceOf(DurableStateError)
    expect((caught as DurableStateError).code).toBe('E_GENERATION_INTEGRITY')
    expect((caught as DurableStateError).file).toBe(file)
  })

  it('still refuses a newer snapshot as newer, not corrupt', () => {
    const { caught } = corrupted((record) => ({ ...record, version: 99 }))
    expect((caught as Error).message).toContain('E_GENERATION_SNAPSHOT_NEWER')
  })
})

describe('pin read-modify-write', () => {
  it('keeps the loop and resources digest across successive writers', () => {
    const { store, generation, pinFile } = fixture()
    const snapshot = generation()
    store.pin('s', snapshot.id, PINS)
    const other = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    const pinned = other.pinSessionResources('s', { data: { a: 1 }, directories: [] })
    const before = statSync(pinFile('s'))
    store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    expect(statSync(pinFile('s'))).toMatchObject({
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
    })
    expect(() => store.recordLoop('s', { id: 'loop', version: '2.0.0' })).toThrow(
      'E_GENERATION_LOOP_INCOMPATIBLE',
    )
    expect(store.session('s')).toMatchObject({ loop: { id: 'loop' }, resourcesDigest: expect.any(String) })
    expect(other.sessionResources('s')).toEqual(pinned)
    expect(readdirSync(join(store.root, 'sessions')).filter((name) => name.endsWith('.lock'))).toEqual([])
  })

  const lockOwner = (pid: number, token = 'foreign') => JSON.stringify({ pid, token })
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number

  it('takes over the lock of a writer whose process is gone', () => {
    const { store, generation, pinFile } = fixture()
    store.pin('s', generation().id, PINS)
    const lock = `${pinFile('s')}.lock`
    writeFileSync(lock, lockOwner(deadPid()))
    store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    expect(existsSync(lock)).toBe(false)
    expect(store.session('s')?.loop?.id).toBe('loop')
  })

  it('never takes over a live holder by age and leaves its lock untouched', () => {
    const fresh = fixture()
    const { store, generation, pinFile } = fresh
    const stalled = new RuntimeGenerationSnapshotStore(fresh.home, { lockWaitMs: 50 })
    store.pin('s', generation().id, PINS)
    const lock = `${pinFile('s')}.lock`
    // A paused or slow holder: its process exists, so no amount of age makes the lock reclaimable.
    writeFileSync(lock, lockOwner(process.pid, 'paused-holder'))
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(lock, old, old)
    let caught: unknown
    try {
      stalled.recordLoop('s', { id: 'loop', version: '1.0.0' })
    } catch (error) {
      caught = error
    }
    expect((caught as DurableStateError).code).toBe('E_GENERATION_PIN_BUSY')
    expect(readFileSync(lock, 'utf8')).toBe(lockOwner(process.pid, 'paused-holder'))
    expect(store.session('s')?.loop).toBeUndefined()
  })

  it('does not report a filesystem error as a busy lock', () => {
    const { store, generation } = fixture()
    store.pin('s', generation().id, PINS)
    // The lock path is unreachable (not a directory), which is neither contention nor a stale lock.
    rmSync(join(store.root, 'sessions'), { recursive: true, force: true })
    writeFileSync(join(store.root, 'sessions'), 'not a directory')
    let caught: unknown
    try {
      store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string }).code).not.toBe('E_GENERATION_PIN_BUSY')
    expect(caught).toBeInstanceOf(Error)
  })

  it('releases only the lock it holds', () => {
    const { store, generation, pinFile } = fixture()
    store.pin('s', generation().id, PINS)
    const lock = `${pinFile('s')}.lock`
    const original = store.session.bind(store)
    // While the body runs, the lock is replaced by another holder's.
    const spy = vi.spyOn(store, 'session').mockImplementationOnce((key) => {
      rmSync(lock, { force: true })
      writeFileSync(lock, lockOwner(process.pid, 'someone-else'))
      return original(key)
    })
    store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    spy.mockRestore()
    expect(readFileSync(lock, 'utf8')).toBe(lockOwner(process.pid, 'someone-else'))
  })

  it('does not resurrect a released pin', () => {
    const { store, generation } = fixture()
    const snapshot = generation()
    store.pin('s', snapshot.id, PINS)
    store.releaseSession('s')
    expect(() => store.recordLoop('s', { id: 'loop', version: '1.0.0' })).toThrow('E_GENERATION_PIN_MISSING')
    expect(store.session('s')).toBeUndefined()
  })

  it('releases a damaged pin without reading it', () => {
    const { store, pinFile } = fixture()
    mkdirSync(join(store.root, 'sessions'), { recursive: true })
    writeFileSync(pinFile('s'), '{')
    store.releaseSession('s')
    expect(existsSync(pinFile('s'))).toBe(false)
  })
})

describe('generation holder identity', () => {
  const dead = (pid: number): string => JSON.stringify({ pid, startId: 'old-start' })

  it('treats a live pid whose start identity changed as a gone holder', async () => {
    const liveness: ProcessLiveness = {
      startId: 'start-now',
      isRunning: async (_pid, startId) => startId === 'start-now',
    }
    const { store, generation } = fixture({ liveness })
    const snapshot = generation()
    const other = new RuntimeGenerationSnapshotStore(join(store.root, '..'), { liveness })
    // The creator's recorded identity belongs to a process that has since exited and whose pid was reused.
    writeFileSync(join(store.root, snapshot.id, 'owner.json'), dead(process.pid))
    const adopters = join(store.root, snapshot.id, 'adopters')
    for (const name of readdirSync(adopters)) writeFileSync(join(adopters, name), dead(process.pid))
    expect(await other.collect(new Set())).toEqual([snapshot.id])
  })

  it('keeps a generation whose holder still has the recorded start identity', async () => {
    const liveness: ProcessLiveness = { startId: 'start-now', isRunning: async () => true }
    const { store, generation } = fixture({ liveness })
    const snapshot = generation()
    const other = new RuntimeGenerationSnapshotStore(join(store.root, '..'), { liveness })
    expect(JSON.parse(readFileSync(join(store.root, snapshot.id, 'owner.json'), 'utf8'))).toEqual({
      pid: process.pid,
      startId: 'start-now',
    })
    expect(await other.collect(new Set())).toEqual([])
  })

  it('treats an unknown identity as running', async () => {
    const liveness: ProcessLiveness = { startId: 's', isRunning: async () => true }
    const { store, generation } = fixture({ liveness })
    const snapshot = generation()
    writeFileSync(join(store.root, snapshot.id, 'owner.json'), dead(process.pid))
    const adopters = join(store.root, snapshot.id, 'adopters')
    for (const name of readdirSync(adopters)) rmSync(join(adopters, name))
    expect(
      await new RuntimeGenerationSnapshotStore(join(store.root, '..'), { liveness }).collect(new Set()),
    ).toEqual([])
  })
})

describe('durable head', () => {
  it('blocks collection while a head file is damaged and recovers once it is republished', async () => {
    const { store, generation } = fixture()
    const first = generation()
    store.setHead('c', first.id)
    const second = generation()
    writeFileSync(join(store.root, 'heads', readdirSync(join(store.root, 'heads'))[0] as string), 'null')
    const other = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    expect(await other.collect(new Set())).toEqual([])
    expect(other.corruptEntries()).toHaveLength(1)
    store.setHead('c', second.id)
    expect(store.headId('c')).toBe(second.id)
  })
})

describe('generation package trees', () => {
  /** A small immutable package tree and the runtime source that names it. */
  function source(home: string) {
    const directory = join(home, 'snapshot')
    mkdirSync(join(directory, 'src'), { recursive: true })
    writeFileSync(join(directory, 'index.mjs'), 'export const main = 1\n')
    writeFileSync(join(directory, 'src', 'data.json'), '{"v":1}\n')
    const snapshot = {
      snapshotId: `sha256-${'c'.repeat(64)}`,
      profile: 'test',
      packageId: '@acme/tree',
      version: '1.0.0',
      integrity: hashDirectory(directory),
      treeIntegrity: hashDirectory(directory, { exclude: [] }),
      capabilityHash: 'd'.repeat(64),
      directory,
      contributions: [],
    }
    return { directory, plugin: { snapshot, generation: 1, trusted: true } }
  }

  it('links a tree this process verified, without hashing it again, into its own directory', async () => {
    const { home, store, target } = fixture()
    const { directory, plugin } = source(home)
    // An opted-in read (a Worker's) verifies and settles the snapshot tree.
    await withPackageVerification(
      async () => verifiedDirectoryDigest(directory, plugin.snapshot, false, true),
      { settleTrees: true },
    )
    const hashed = vi.spyOn(sources, 'hashDirectoryAsync')
    const created = await store.createAsync(target, [plugin], 'compat', undefined, undefined, SEAMS)
    expect(hashed).not.toHaveBeenCalled()
    const linked = join(created.sources[0]!.snapshot.directory, 'index.mjs')
    expect(created.sources[0]!.snapshot.directory).not.toBe(directory)
    expect(statSync(linked).ino).toBe(statSync(join(directory, 'index.mjs')).ino)
    // The generation keeps its bytes after the runtime snapshot is collected.
    rmSync(directory, { recursive: true })
    expect(readFileSync(linked, 'utf8')).toBe('export const main = 1\n')
    expect((await store.readAsync(created.id)).sources).toHaveLength(1)
    hashed.mockRestore()
  })

  it('hashes a tree no read of this process verified, and refuses one that changed', async () => {
    const { home, store, target } = fixture()
    const { directory, plugin } = source(home)
    const hashed = vi.spyOn(sources, 'hashDirectoryAsync')
    await store.createAsync(target, [plugin], 'compat', undefined, undefined, SEAMS)
    expect(hashed).toHaveBeenCalledTimes(1)
    hashed.mockRestore()
    writeFileSync(join(directory, 'index.mjs'), 'export const main = 2\n')
    await expect(store.createAsync(target, [plugin], 'compat', undefined, undefined, SEAMS)).rejects.toThrow(
      'E_GENERATION_INTEGRITY',
    )
  })
})
