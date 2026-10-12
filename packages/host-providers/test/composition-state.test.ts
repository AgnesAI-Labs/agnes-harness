import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity-default'
import { afterEach, describe, expect, it } from 'vitest'
import { CompositionSessionStore, reapDeadLiveCompositions } from '../src/profile/composition-state.js'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const home = () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-composition-state-'))
  homes.push(directory)
  return directory
}
const age = (path: string, ms: number) => {
  const when = new Date(Date.now() - ms)
  utimesSync(path, when, when)
}
const HOUR = 60 * 60_000

describe('composition binding orphan sweep', () => {
  const bindingFile = (store: CompositionSessionStore, key: string, ageMs: number) => {
    mkdirSync(store.root, { recursive: true })
    const path = join(store.root, `${createHash('sha256').update(key).digest('hex')}.json`)
    writeFileSync(path, JSON.stringify({ sessionKey: key, profile: { name: 'snapshot' } }))
    age(path, ageMs)
    return path
  }

  it('removes stale bindings without a generation pin and keeps pinned and fresh ones', () => {
    const store = new CompositionSessionStore(home())
    const orphan = bindingFile(store, 'orphan', HOUR),
      pinned = bindingFile(store, 'pinned', HOUR),
      opening = bindingFile(store, 'opening', 0)
    const removed = store.sweepOrphans((key) => key === 'pinned')
    expect(removed).toHaveLength(1)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(pinned)).toBe(true)
    expect(existsSync(opening)).toBe(true)
  })

  it('keeps a binding whose pin cannot be read', () => {
    const store = new CompositionSessionStore(home())
    const path = bindingFile(store, 'unreadable-pin', HOUR)
    store.sweepOrphans(() => {
      throw new Error('E_GENERATION_INTEGRITY')
    })
    expect(existsSync(path)).toBe(true)
  })

  it('removes interrupted pin temporaries and unparseable stale bindings', () => {
    const store = new CompositionSessionStore(home())
    mkdirSync(store.root, { recursive: true })
    const temporary = join(store.root, `${'a'.repeat(64)}.json.${randomUUID()}`),
      torn = join(store.root, `${'b'.repeat(64)}.json`)
    writeFileSync(temporary, '{')
    writeFileSync(torn, '{')
    age(temporary, HOUR)
    age(torn, HOUR)
    store.sweepOrphans(() => true)
    expect(existsSync(temporary)).toBe(false)
    expect(existsSync(torn)).toBe(false)
  })
})

describe('dead worker live-composition status', () => {
  it('reaps files of dead or recycled workers and keeps a live worker', async () => {
    const profile = home(),
      root = join(profile, '.composition-live')
    mkdirSync(root, { recursive: true })
    const self = await defaultProcessIdentity(process.pid)
    if (self.state !== 'alive') return
    const write = (record: unknown) => {
      const path = join(root, `${randomUUID()}.json`)
      writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record))
      return path
    }
    const dead = write({ pid: spawnSync(process.execPath, ['-e', '']).pid, startId: 'x', sessions: [] }),
      recycled = write({ pid: process.pid, startId: 'not-this-process', sessions: [] }),
      torn = write('{'),
      live = write({ pid: process.pid, startId: self.startId, sessions: [] })
    await reapDeadLiveCompositions(profile)
    expect([dead, recycled, torn].map(existsSync)).toEqual([false, false, false])
    expect(existsSync(live)).toBe(true)
  })
})
