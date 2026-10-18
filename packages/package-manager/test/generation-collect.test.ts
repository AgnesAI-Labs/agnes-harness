import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
import { buildRuntimeTarget, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeGenerationSnapshotStore } from '../src/runtime-snapshots-generations.js'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const SELECTIONS = Object.fromEntries(
  SEAM_KINDS.map((kind) => [kind, { provider: `${kind}-provider`, version: '1.0.0' }]),
)
const holder = (pid: number): string => JSON.stringify({ pid })

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agh-generation-collect-'))
  homes.push(home)
  const store = new RuntimeGenerationSnapshotStore(home)
  const generation = (files: Record<string, string>, ageMs = 0): string => {
    const id = randomUUID(),
      directory = join(store.root, id)
    mkdirSync(directory, { recursive: true })
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes)
    const when = new Date(Date.now() - ageMs)
    utimesSync(directory, when, when)
    return id
  }
  return { store, generation }
}

describe('generation collection with unreadable owner metadata', () => {
  it('removes a torn generation whose recorded owner is gone', async () => {
    const { store, generation } = fixture()
    const id = generation({ 'generation.json': '{"id":', 'owner.json': holder(deadPid()) })
    expect(await store.collect(new Set())).toEqual([id])
  })

  it('keeps a torn generation whose recorded owner is alive', async () => {
    const { store, generation } = fixture()
    const id = generation({ 'generation.json': '{"id":', 'owner.json': holder(process.pid) })
    expect(await store.collect(new Set())).toEqual([])
    expect(existsSync(join(store.root, id))).toBe(true)
  })

  it('removes an ownerless torn generation only after the creation grace', async () => {
    const { store, generation } = fixture()
    const fresh = generation({ 'generation.json': '{"id":' })
    const stale = generation({ 'generation.json': '{"id":' }, 60 * 60_000)
    expect(await store.collect(new Set())).toEqual([stale])
    expect(existsSync(join(store.root, fresh))).toBe(true)
  })

  it('never removes a generation a session pin references', async () => {
    const { store, generation } = fixture()
    const id = generation({ 'generation.json': '{"id":' }, 60 * 60_000)
    store.pin('session-a', id, [])
    expect(await store.collect(new Set())).toEqual([])
  })
})

describe('durable composition head', () => {
  const target = (revision: string) =>
    buildRuntimeTarget({
      rows: [],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision.repeat(64).slice(0, 64),
      compositeRevision: 'b'.repeat(64),
    })
  const create = (store: RuntimeGenerationSnapshotStore, revision: string) =>
    store.create(target(revision), [], 'compat', [], undefined, { formatVersion: 1, selections: SELECTIONS })
  const expected = (revision: string) => ({
    artifactDigest: encodeRuntimeTargetArtifact(target(revision)).digest,
    compatibility: 'compat',
    packages: [],
    seams: { formatVersion: 1 as const, selections: SELECTIONS },
  })

  it('lets a later worker reuse the recorded head only for identical inputs', async () => {
    const { store } = fixture()
    const snapshot = create(store, 'a')
    store.setHead('composition-a', snapshot.id)
    const later = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    expect(later.reusableHead('composition-a', expected('a'))?.id).toBe(snapshot.id)
    expect(later.reusableHead('composition-a', expected('c'))).toBeUndefined()
    expect(later.reusableHead('composition-a', { ...expected('a'), compatibility: 'other' })).toBeUndefined()
    expect(later.reusableHead('composition-b', expected('a'))).toBeUndefined()
    const remembered = later.headId('composition-a')
    later.setHead('composition-a', create(later, 'c').id)
    expect(later.reusableHead('composition-a', expected('a'))).toBeUndefined()
    expect(later.reusableHead('composition-a', expected('a'), remembered)?.id).toBe(snapshot.id)
    expect(later.reusableHead('composition-a', expected('c'), remembered)).toBeUndefined()
  })

  it('keeps a head generation after its creator is gone and ignores an unreadable pointer', async () => {
    const { store } = fixture()
    const snapshot = create(store, 'a')
    store.setHead('composition-a', snapshot.id)
    // A worker in another process: nothing here created or keeps the generation.
    const other = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    writeFileSync(join(store.root, snapshot.id, 'owner.json'), holder(deadPid()))
    const adopters = join(store.root, snapshot.id, 'adopters')
    for (const name of readdirSync(adopters)) writeFileSync(join(adopters, name), holder(deadPid()))
    expect(await other.collect(new Set())).toEqual([])
    const next = create(store, 'c')
    store.setHead('composition-a', next.id)
    expect(await other.collect(new Set())).toEqual([snapshot.id])
    writeFileSync(join(store.root, 'heads', readdirSync(join(store.root, 'heads'))[0]!), '{')
    expect(other.reusableHead('composition-a', expected('c'))).toBeUndefined()
  })

  it('keeps a reused head generation for its adopter after the creator publishes a newer head and closes', async () => {
    const { store } = fixture()
    const home = join(store.root, '..')
    const adopter = new RuntimeGenerationSnapshotStore(home)
    const shared = create(store, 'a')
    store.setHead('composition-a', shared.id)
    expect(adopter.reusableHead('composition-a', expected('a'))?.id).toBe(shared.id)
    const newer = create(store, 'c')
    store.setHead('composition-a', newer.id)
    // The creator closes with nothing of its own to keep; the adopter has no session pin yet.
    expect(await store.collect(new Set())).toEqual([])
    expect(adopter.pin('session-a', shared.id, []).generationId).toBe(shared.id)
    adopter.releaseSession('session-a')
    expect(await adopter.collect(new Set([shared.id]))).toEqual([])
    // Once the creator is gone and the adopter lets go, the generation is reclaimed.
    writeFileSync(join(store.root, shared.id, 'owner.json'), holder(deadPid()))
    expect(await adopter.collect(new Set())).toEqual([shared.id])
  })

  it('ignores an adopter whose process is gone', async () => {
    const { store } = fixture()
    const adopter = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    const shared = create(store, 'a')
    store.setHead('composition-a', shared.id)
    expect(adopter.reusableHead('composition-a', expected('a'))?.id).toBe(shared.id)
    const newer = create(store, 'c')
    store.setHead('composition-a', newer.id)
    const adopters = join(store.root, shared.id, 'adopters')
    for (const name of readdirSync(adopters)) writeFileSync(join(adopters, name), holder(deadPid()))
    expect(await store.collect(new Set())).toEqual([shared.id])
  })
})

/**
 * Two stores over one profile stand in for two processes. The collector's liveness probe is the stop
 * point: it answers "gone" for the recorded adopter, but only when the test opens the numbered gate, so
 * the other store acts exactly between the collector's checks and its delete.
 */
describe('adopt, pin and collect across stores', () => {
  const target = (revision: string) =>
    buildRuntimeTarget({
      rows: [],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision.repeat(64).slice(0, 64),
      compositeRevision: 'b'.repeat(64),
    })
  const seams = { formatVersion: 1 as const, selections: SELECTIONS }
  const create = (store: RuntimeGenerationSnapshotStore, revision: string) =>
    store.create(target(revision), [], 'compat', [], undefined, seams)
  const expected = (revision: string) => ({
    artifactDigest: encodeRuntimeTargetArtifact(target(revision)).digest,
    compatibility: 'compat',
    packages: [],
    seams,
  })

  function scenario() {
    const home = mkdtempSync(join(tmpdir(), 'agh-generation-race-'))
    homes.push(home)
    const stops = new Map<
      number,
      { reached: Promise<void>; open: () => void; mark: () => void; gate: Promise<void> }
    >()
    const stop = (turn: number) => {
      let entry = stops.get(turn)
      if (!entry) {
        let mark!: () => void, open!: () => void
        const reached = new Promise<void>((resolve) => (mark = resolve))
        const gate = new Promise<void>((resolve) => (open = resolve))
        entry = { reached, gate, mark, open }
        stops.set(turn, entry)
      }
      return entry
    }
    let probes = 0
    const collector = new RuntimeGenerationSnapshotStore(home, {
      liveness: {
        startId: 'collector',
        isRunning: async () => {
          const entry = stop(++probes)
          entry.mark()
          await entry.gate
          return false
        },
      },
    })
    const worker = new RuntimeGenerationSnapshotStore(home)
    const old = create(worker, 'a')
    // The generation's creator is gone; the only record left is an adopter the collector must probe.
    writeFileSync(join(worker.root, old.id, 'owner.json'), holder(deadPid()))
    const adopters = join(worker.root, old.id, 'adopters')
    for (const name of readdirSync(adopters))
      writeFileSync(join(adopters, name), JSON.stringify({ pid: deadPid(), startId: 'gone' }))
    // The composition's head has moved on, so nothing references the old generation at the first scan.
    const newer = create(worker, 'c')
    worker.setHead('composition-a', newer.id)
    return { worker, collector, old, newer, stop }
  }

  it('keeps a generation another worker adopted after the collector checked it', async () => {
    const { worker, collector, old, newer, stop } = scenario()
    const collecting = collector.collect(new Set())
    await stop(1).reached
    // The head returns to the old generation, another worker adopts it, then the head moves on again.
    worker.setHead('composition-a', old.id)
    expect(
      new RuntimeGenerationSnapshotStore(join(worker.root, '..')).reusableHead('composition-a', expected('a'))
        ?.id,
    ).toBe(old.id)
    worker.setHead('composition-a', newer.id)
    // Whether the verdict probes the recorded adopter again depends on which adopter it meets first.
    stop(1).open()
    stop(2).open()
    expect(await collecting).toEqual([])
    expect(worker.read(old.id).id).toBe(old.id)
  })

  it('keeps a generation another worker pinned after the collector checked it', async () => {
    const { worker, collector, old, stop } = scenario()
    const collecting = collector.collect(new Set())
    await stop(1).reached
    worker.pin('session-a', old.id, [])
    stop(1).open()
    expect(await collecting).toEqual([])
    expect(worker.read(worker.session('session-a')!.generationId).id).toBe(old.id)
  })

  it('refuses every new reference once the generation is claimed, and removes it', async () => {
    const { worker, collector, old, stop } = scenario()
    const collecting = collector.collect(new Set())
    await stop(1).reached
    stop(1).open()
    // The claim is made; the verdict (second probe) has not been reached.
    await stop(2).reached
    expect(() => worker.pin('session-a', old.id, [])).toThrow('E_GENERATION_SNAPSHOT_MISSING')
    expect(worker.session('session-a')).toBeUndefined()
    expect(() => worker.setHead('composition-b', old.id)).toThrow('E_GENERATION_SNAPSHOT_MISSING')
    expect(worker.headId('composition-b')).toBeUndefined()
    expect(
      new RuntimeGenerationSnapshotStore(join(worker.root, '..')).reusableHead(
        'composition-a',
        expected('a'),
      ),
    ).toBeUndefined()
    stop(2).open()
    expect(await collecting).toEqual([old.id])
    expect(existsSync(join(worker.root, old.id))).toBe(false)
  })
})
