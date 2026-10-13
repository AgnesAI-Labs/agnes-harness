import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SEAM_KINDS } from '@agnes/extension-api/seams'
import { buildRuntimeTarget } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DurableStateError,
  type PinnedSeam,
  type ProcessLiveness,
  RuntimeGenerationSnapshotStore,
} from '../src/runtime-snapshots-generations.js'

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
  return { home, store, generation, pinFile }
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
  const corrupted = (mutate: (record: Record<string, unknown>) => unknown) => {
    const { store, generation } = fixture()
    const snapshot = generation()
    const file = join(store.root, snapshot.id, 'generation.json')
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify(mutate(record)))
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
    const { store, generation } = fixture()
    const snapshot = generation()
    store.pin('s', snapshot.id, PINS)
    const other = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    const pinned = other.pinSessionResources('s', { data: { a: 1 }, directories: [] })
    store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    expect(store.session('s')).toMatchObject({ loop: { id: 'loop' }, resourcesDigest: expect.any(String) })
    expect(other.sessionResources('s')).toEqual(pinned)
    expect(readdirSync(join(store.root, 'sessions')).filter((name) => name.endsWith('.lock'))).toEqual([])
  })

  it('reclaims the lock of a crashed writer and refuses while a fresh one is held', () => {
    const { store, generation, pinFile } = fixture()
    const snapshot = generation()
    store.pin('s', snapshot.id, PINS)
    const lock = `${pinFile('s')}.lock`
    mkdirSync(lock)
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(lock, old, old)
    store.recordLoop('s', { id: 'loop', version: '1.0.0' })
    expect(existsSync(lock)).toBe(false)
    expect(store.session('s')?.loop?.id).toBe('loop')
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
