import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveComposition } from '@agnes/host-common/profile/composition'
import { resolveProfile } from '@agnes/host-common/profile/resolve'
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
    const digest = (key: string) => createHash('sha256').update(key).digest('hex')
    const removed = store.sweepOrphans((hash) => (hash === digest('pinned') ? 'present' : 'absent'))
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

  it('keeps a damaged binding while its generation pin exists and refuses to resume it', () => {
    const store = new CompositionSessionStore(home())
    mkdirSync(store.root, { recursive: true })
    const key = 'saved-session',
      path = join(store.root, `${createHash('sha256').update(key).digest('hex')}.json`)
    writeFileSync(path, '{')
    age(path, HOUR)
    const asked: string[] = []
    expect(
      store.sweepOrphans((digest) => {
        asked.push(digest)
        return 'present'
      }),
    ).toEqual([])
    expect(asked).toEqual([createHash('sha256').update(key).digest('hex')])
    expect(existsSync(path)).toBe(true)
    expect(() => store.read(key)).toThrow(/E_COMPOSITION_BINDING_INVALID/)
    try {
      store.read(key)
    } catch (error) {
      expect((error as { file?: string }).file).toBe(path)
    }
  })

  it('removes a damaged binding only when its pin is positively absent', () => {
    const store = new CompositionSessionStore(home())
    mkdirSync(store.root, { recursive: true })
    const path = join(store.root, `${createHash('sha256').update('never-pinned').digest('hex')}.json`)
    writeFileSync(path, '{')
    age(path, HOUR)
    expect(store.sweepOrphans(() => 'absent')).toHaveLength(1)
    expect(existsSync(path)).toBe(false)
  })

  it('reports every shape failure of a binding as a located invalid binding', () => {
    const store = new CompositionSessionStore(home())
    mkdirSync(store.root, { recursive: true })
    for (const [key, content] of [
      ['null-binding', 'null'],
      ['no-tree', JSON.stringify({ sessionKey: 'no-tree', profile: { name: 'p' } })],
      [
        'bad-selection',
        JSON.stringify({
          sessionKey: 'bad-selection',
          profile: { name: 'p' },
          tree: { profile: 'p', hash: `sha256-${'a'.repeat(64)}`, selection: 3 },
        }),
      ],
    ] as const) {
      writeFileSync(join(store.root, `${createHash('sha256').update(key).digest('hex')}.json`), content)
      expect(() => store.read(key)).toThrow(/E_COMPOSITION_BINDING_INVALID/)
    }
  })

  it('decodes the whole record: a valid binding round-trips, every damaged field is a located refusal', async () => {
    const profile = await resolveProfile(
      { builtin: 'local-dev', user: { name: 'local-dev' } },
      {
        platform: { os: 'linux', arch: 'x64', capabilities: {} },
        agnesVersion: '1.4.0',
        now: '2026-10-07',
        homeDir: '/synthetic/home',
      },
    )
    const tree = resolveComposition(profile)
    const store = new CompositionSessionStore(home())
    const saved = store.pin({ sessionKey: 'whole', tree, profile })
    expect(saved.tree.hash).toBe(tree.hash)

    const damage: Record<string, (record: any) => void> = {
      'profile without packages': (r) => delete r.profile.packages,
      'null package element': (r) => (r.profile.packages = [null]),
      'null rows': (r) => (r.tree.rows = null),
      'null bundles': (r) => (r.tree.bundles = null),
      'null sources': (r) => (r.tree.sources = null),
      'bad source layer': (r) => (r.tree.sources.loop = { layer: 'nowhere', name: 'x' }),
      'bad tool scope': (r) => (r.tree.toolScope = { bundlePackages: 3, activePackages: [] }),
      'selection changed under the hash': (r) => (r.tree.selection.tools = ['write']),
      'adapters not an object': (r) => (r.profile.adapters = null),
      'legacy not true': (r) => (r.legacy = 'yes'),
    }
    for (const [name, mutate] of Object.entries(damage)) {
      const record = JSON.parse(JSON.stringify({ sessionKey: 'whole', tree, profile }))
      mutate(record)
      const file = join(store.root, `${createHash('sha256').update('whole').digest('hex')}.json`)
      writeFileSync(file, JSON.stringify(record))
      let error: { code?: string; file?: string } | undefined
      try {
        store.read('whole')
      } catch (caught) {
        error = caught as typeof error
      }
      expect(error?.code, name).toBe('E_COMPOSITION_BINDING_INVALID')
      expect(error?.file, name).toBe(file)
    }
  })

  it('removes interrupted pin temporaries and stale bindings whose pin is absent', () => {
    const store = new CompositionSessionStore(home())
    mkdirSync(store.root, { recursive: true })
    const temporary = join(store.root, `${'a'.repeat(64)}.json.${randomUUID()}`),
      torn = join(store.root, `${'b'.repeat(64)}.json`)
    writeFileSync(temporary, '{')
    writeFileSync(torn, '{')
    age(temporary, HOUR)
    age(torn, HOUR)
    store.sweepOrphans(() => 'absent')
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
