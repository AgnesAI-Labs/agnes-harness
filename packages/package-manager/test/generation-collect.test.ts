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
import { matchesGenerationBuildInputs, sameGenerationCodeAndSources } from '../src/generation-equivalence.js'
import type { RuntimePluginSnapshot } from '../src/package-plugin-loader.js'
import { RuntimeGenerationSnapshotStore } from '../src/runtime-snapshots-generations.js'
import { generationResourcesDigest } from '../src/runtime-snapshots-resources.js'

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

describe('reusing an identical generation for a publication', () => {
  const target = (revision: string) =>
    buildRuntimeTarget({
      rows: [],
      resources: { mcp: [], skills: {} },
      resourceRevision: revision.repeat(64).slice(0, 64),
      compositeRevision: 'b'.repeat(64),
    })
  const seams = { formatVersion: 1 as const, selections: SELECTIONS }
  const resources = { data: { rows: [] }, directories: [] }
  const create = (store: RuntimeGenerationSnapshotStore, revision: string) =>
    store.create(target(revision), [], 'compat', [{ id: 'pkg', version: '1.0.0' }], resources, seams)
  const expected = (revision: string) => ({
    artifactDigest: encodeRuntimeTargetArtifact(target(revision)).digest,
    compatibility: 'compat',
    packages: [{ id: 'pkg', version: '1.0.0' }],
    resourcesDigest: generationResourcesDigest(resources),
    seams,
  })
  /** A worker that boots on a snapshot of its own target replaces the previous worker's head. */
  const restarted = (home: string, previous: string) => {
    const worker = new RuntimeGenerationSnapshotStore(home)
    const boot = create(worker, 'c')
    worker.setHead('composition-a', boot.id)
    expect(worker.headId('composition-a')).not.toBe(previous)
    return worker
  }

  it('takes the head it replaced when the publication matches it, and adopts it', () => {
    const { store } = fixture()
    const previous = create(store, 'a')
    store.setHead('composition-a', previous.id)
    const worker = restarted(join(store.root, '..'), previous.id)
    const reused = worker.reusableGeneration('composition-a', expected('a'), new Set())
    expect(reused?.id).toBe(previous.id)
    expect(matchesGenerationBuildInputs(previous, expected('a'))).toBe(true)
    expect(sameGenerationCodeAndSources(previous, { ...previous, id: 'another-id' })).toBe(true)
    const source: RuntimePluginSnapshot = {
      snapshot: {
        packageId: 'pkg',
        snapshotId: 'other-source',
        directory: '/synthetic',
        version: '1.0.0',
        profile: 'local-dev',
        integrity: 'sha256-source',
        treeIntegrity: 'tree',
        capabilityHash: 'capabilities',
        contributions: [],
      },
      generation: 1,
      trusted: true,
    }
    const changedSources = { ...previous, sources: [source] }
    expect(matchesGenerationBuildInputs(changedSources, expected('a'))).toBe(true)
    expect(sameGenerationCodeAndSources(previous, changedSources)).toBe(false)
    expect(
      sameGenerationCodeAndSources(changedSources, {
        ...changedSources,
        sources: [{ ...source, snapshot: { ...source.snapshot, directory: '/archive' } }],
      }),
    ).toBe(true)
    expect(readdirSync(join(store.root, previous.id, 'adopters'))).toHaveLength(2)
  })

  it('takes a generation a session pin names', () => {
    const { store } = fixture()
    const pinned = create(store, 'a')
    store.pin('session-a', pinned.id, [])
    const worker = restarted(join(store.root, '..'), pinned.id)
    expect(worker.reusableGeneration('composition-a', expected('a'), new Set())?.id).toBe(pinned.id)
    // The caller already runs it: a publication must not take over that generation's identity.
    expect(worker.reusableGeneration('composition-a', expected('a'), new Set([pinned.id]))).toBeUndefined()
  })

  it.each([
    ['target digest', { artifactDigest: expected('d').artifactDigest }],
    ['compatibility', { compatibility: 'other' }],
    ['package list', { packages: [{ id: 'pkg', version: '1.0.1' }] }],
    ['resources digest', { resourcesDigest: generationResourcesDigest({ data: {}, directories: [] }) }],
    ['seam selections', { seams: { ...seams, selections: { ...SELECTIONS, approval: { provider: 'x' } } } }],
  ])('snapshots afresh when the recorded %s does not match', (_field, change) => {
    const { store } = fixture()
    const previous = create(store, 'a')
    store.setHead('composition-a', previous.id)
    const worker = restarted(join(store.root, '..'), previous.id)
    expect(
      worker.reusableGeneration('composition-a', { ...expected('a'), ...change }, new Set()),
    ).toBeUndefined()
    expect(worker.reusableGeneration('composition-a', expected('a'), new Set())?.id).toBe(previous.id)
  })

  it('skips a candidate with accepted live configuration or a damaged record, without adopting it', () => {
    const { store } = fixture()
    const configured = create(store, 'a')
    store.saveLiveConfig(configured.id, encodeRuntimeTargetArtifact(target('a')))
    store.pin('session-a', configured.id, [])
    const damaged = create(store, 'a')
    store.pin('session-b', damaged.id, [])
    writeFileSync(join(store.root, damaged.id, 'resources', 'resources.json'), '{}')
    const worker = restarted(join(store.root, '..'), damaged.id)
    expect(worker.reusableGeneration('composition-a', expected('a'), new Set())).toBeUndefined()
    for (const id of [configured.id, damaged.id])
      expect(readdirSync(join(store.root, id, 'adopters'))).toHaveLength(1)
    const intact = create(store, 'a')
    store.pin('session-c', intact.id, [])
    expect(worker.reusableGeneration('composition-a', expected('a'), new Set())?.id).toBe(intact.id)
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

  it('keeps a generation a publication reused after the collector checked it', async () => {
    const { worker, collector, old, newer, stop } = scenario()
    // This worker once recorded the old generation as its head, so a publication may take it again.
    worker.setHead('composition-a', old.id)
    worker.setHead('composition-a', newer.id)
    const collecting = collector.collect(new Set())
    await stop(1).reached
    expect(worker.reusableGeneration('composition-a', expected('a'), new Set())?.id).toBe(old.id)
    stop(1).open()
    stop(2).open()
    expect(await collecting).toEqual([])
    expect(worker.read(old.id).id).toBe(old.id)
  })

  it('reuses nothing once the generation is claimed', async () => {
    const { worker, collector, old, newer, stop } = scenario()
    worker.setHead('composition-a', old.id)
    worker.setHead('composition-a', newer.id)
    const collecting = collector.collect(new Set())
    await stop(1).reached
    stop(1).open()
    await stop(2).reached
    expect(worker.reusableGeneration('composition-a', expected('a'), new Set())).toBeUndefined()
    stop(2).open()
    expect(await collecting).toEqual([old.id])
    expect(existsSync(join(worker.root, old.id))).toBe(false)
  })
})
