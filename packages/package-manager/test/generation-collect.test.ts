import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
