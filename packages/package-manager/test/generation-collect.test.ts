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
import { buildRuntimeTarget, encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeGenerationSnapshotStore } from '../src/runtime-snapshots-generations.js'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

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
  it('removes a torn generation whose recorded owner is gone', () => {
    const { store, generation } = fixture()
    const id = generation({ 'generation.json': '{"id":', 'owner.pid': String(deadPid()) })
    expect(store.collect(new Set())).toEqual([id])
  })

  it('keeps a torn generation whose recorded owner is alive', () => {
    const { store, generation } = fixture()
    const id = generation({ 'generation.json': '{"id":', 'owner.pid': String(process.pid) })
    expect(store.collect(new Set())).toEqual([])
    expect(existsSync(join(store.root, id))).toBe(true)
  })

  it('removes an ownerless torn generation only after the creation grace', () => {
    const { store, generation } = fixture()
    const fresh = generation({ 'generation.json': '{"id":' })
    const stale = generation({ 'generation.json': '{"id":' }, 60 * 60_000)
    expect(store.collect(new Set())).toEqual([stale])
    expect(existsSync(join(store.root, fresh))).toBe(true)
  })

  it('never removes a generation a session pin references', () => {
    const { store, generation } = fixture()
    const id = generation({ 'generation.json': '{"id":' }, 60 * 60_000)
    store.pin('session-a', id)
    expect(store.collect(new Set())).toEqual([])
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
    store.create(target(revision), [], 'compat', [], undefined, { formatVersion: 1, selections: {} })
  const expected = (revision: string) => ({
    artifactDigest: encodeRuntimeTargetArtifact(target(revision)).digest,
    compatibility: 'compat',
    packages: [],
    seams: { formatVersion: 1 as const, selections: {} },
  })

  it('lets a later worker reuse the recorded head only for identical inputs', () => {
    const { store } = fixture()
    const snapshot = create(store, 'a')
    store.setHead('composition-a', snapshot.id)
    const later = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    expect(later.reusableHead('composition-a', expected('a'))?.id).toBe(snapshot.id)
    expect(later.reusableHead('composition-a', expected('c'))).toBeUndefined()
    expect(later.reusableHead('composition-a', { ...expected('a'), compatibility: 'other' })).toBeUndefined()
    expect(later.reusableHead('composition-b', expected('a'))).toBeUndefined()
  })

  it('keeps a head generation after its creator is gone and ignores an unreadable pointer', () => {
    const { store } = fixture()
    const snapshot = create(store, 'a')
    store.setHead('composition-a', snapshot.id)
    // A worker in another process: nothing here created or keeps the generation.
    const other = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    writeFileSync(join(store.root, snapshot.id, 'owner.pid'), String(deadPid()))
    writeFileSync(
      join(store.root, snapshot.id, 'generation.json'),
      JSON.stringify({
        ...JSON.parse(readFileSync(join(store.root, snapshot.id, 'generation.json'), 'utf8')),
        ownerPid: deadPid(),
      }),
    )
    const adopters = join(store.root, snapshot.id, 'adopters')
    for (const name of readdirSync(adopters)) writeFileSync(join(adopters, name), String(deadPid()))
    expect(other.collect(new Set())).toEqual([])
    const next = create(store, 'c')
    store.setHead('composition-a', next.id)
    expect(other.collect(new Set())).toEqual([snapshot.id])
    writeFileSync(join(store.root, 'heads', readdirSync(join(store.root, 'heads'))[0]!), '{')
    expect(other.reusableHead('composition-a', expected('c'))).toBeUndefined()
  })

  it('keeps a reused head generation for its adopter after the creator publishes a newer head and closes', () => {
    const { store } = fixture()
    const home = join(store.root, '..')
    const adopter = new RuntimeGenerationSnapshotStore(home)
    const shared = create(store, 'a')
    store.setHead('composition-a', shared.id)
    expect(adopter.reusableHead('composition-a', expected('a'))?.id).toBe(shared.id)
    const newer = create(store, 'c')
    store.setHead('composition-a', newer.id)
    // The creator closes with nothing of its own to keep; the adopter has no session pin yet.
    expect(store.collect(new Set())).toEqual([])
    expect(adopter.pin('session-a', shared.id).generationId).toBe(shared.id)
    adopter.releaseSession('session-a')
    expect(adopter.collect(new Set([shared.id]))).toEqual([])
    // Once the creator is gone and the adopter lets go, the generation is reclaimed.
    writeFileSync(join(store.root, shared.id, 'owner.pid'), String(deadPid()))
    writeFileSync(
      join(store.root, shared.id, 'generation.json'),
      JSON.stringify({
        ...JSON.parse(readFileSync(join(store.root, shared.id, 'generation.json'), 'utf8')),
        ownerPid: deadPid(),
      }),
    )
    expect(adopter.collect(new Set())).toEqual([shared.id])
  })

  it('ignores an adopter whose process is gone', () => {
    const { store } = fixture()
    const adopter = new RuntimeGenerationSnapshotStore(join(store.root, '..'))
    const shared = create(store, 'a')
    store.setHead('composition-a', shared.id)
    expect(adopter.reusableHead('composition-a', expected('a'))?.id).toBe(shared.id)
    const newer = create(store, 'c')
    store.setHead('composition-a', newer.id)
    const adopters = join(store.root, shared.id, 'adopters')
    for (const name of readdirSync(adopters)) writeFileSync(join(adopters, name), String(deadPid()))
    expect(store.collect(new Set())).toEqual([shared.id])
  })
})
