import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEnvironment } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { CompositionSessionStore } from '../src/profile/composition-state.js'
import { SessionEnvironmentStore } from '../src/profile/session-environment.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-session-environment-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'test')
  mkdirSync(profileDir, { recursive: true })
  return { profileDir, store: new SessionEnvironmentStore(profileDir) }
}
const ENVIRONMENT: SessionEnvironment = {
  pathPrepend: ['/state/worker-bin'],
  set: { GIT_CONFIG_GLOBAL: '/state/worker-gitconfig' },
  unset: ['GH_TOKEN'],
}
const fileOf = (profileDir: string, key: string) =>
  join(profileDir, '.session-environment', `${createHash('sha256').update(key).digest('hex')}.json`)

/** A store as a newly started process has it, with nothing remembered yet. */
async function freshStore(profileDir: string): Promise<SessionEnvironmentStore> {
  vi.resetModules()
  const fresh = await import('../src/profile/session-environment.js')
  return new fresh.SessionEnvironmentStore(profileDir)
}

it("keeps a session's environment for whoever opens the session next, and removes it with the session", async () => {
  const { profileDir, store } = setup()
  expect(store.read('s')).toBeUndefined()
  store.write('s', ENVIRONMENT)
  // Read from disk by another process, as after a restart.
  expect((await freshStore(profileDir)).read('s')).toEqual(ENVIRONMENT)
  expect(store.read('other')).toBeUndefined()
  // The same environment again writes nothing; another one replaces it.
  const written = statSync(fileOf(profileDir, 's')).mtimeMs
  store.write('s', ENVIRONMENT)
  expect(statSync(fileOf(profileDir, 's')).mtimeMs).toBe(written)
  store.write('s', { unset: ['GH_TOKEN'] })
  expect(store.read('s')).toEqual({ unset: ['GH_TOKEN'] })
  new CompositionSessionStore(profileDir).release('s')
  expect(existsSync(fileOf(profileDir, 's'))).toBe(false)
  expect(store.read('s')).toBeUndefined()
})

it('refuses a damaged record, one for another session or one that sets a credential, rather than run without it', () => {
  const { profileDir, store } = setup()
  mkdirSync(join(profileDir, '.session-environment'))
  const file = fileOf(profileDir, 's')
  for (const bytes of [
    '{',
    JSON.stringify({ version: 1, sessionKey: 'other', environment: ENVIRONMENT }),
    JSON.stringify({ version: 1, sessionKey: 's', environment: { set: { GH_TOKEN: 'x' } } }),
    JSON.stringify({ version: 2, sessionKey: 's', environment: ENVIRONMENT }),
  ]) {
    writeFileSync(file, bytes)
    expect(() => store.read('s'), bytes).toThrow('E_SESSION_ENVIRONMENT')
  }
  expect(() => store.write('s', { set: { GH_TOKEN: 'x' } })).toThrow(/cannot set/)
})

it('answers from memory once a session is known, and every store of the process sees a write or removal at once', () => {
  const { profileDir, store } = setup()
  const record = (key: string, environment: SessionEnvironment) => {
    mkdirSync(join(profileDir, '.session-environment'), { recursive: true })
    writeFileSync(fileOf(profileDir, key), JSON.stringify({ version: 1, sessionKey: key, environment }))
  }
  // A session without a record is read from disk once; a record that appears behind the store's back is not read.
  expect(store.read('none')).toBeUndefined()
  record('none', ENVIRONMENT)
  expect(store.read('none')).toBeUndefined()
  // A write through any store over the profile is what the next read sees, and so is a removal.
  new SessionEnvironmentStore(profileDir).write('none', ENVIRONMENT)
  expect(store.read('none')).toEqual(ENVIRONMENT)
  new CompositionSessionStore(profileDir).release('none')
  expect(store.read('none')).toBeUndefined()
  // A record that cannot be read is not remembered: it refuses each command until it is put right.
  record('broken', ENVIRONMENT)
  writeFileSync(fileOf(profileDir, 'broken'), '{')
  expect(() => store.read('broken')).toThrow('E_SESSION_ENVIRONMENT')
  expect(() => store.read('broken')).toThrow('E_SESSION_ENVIRONMENT')
  record('broken', ENVIRONMENT)
  expect(store.read('broken')).toEqual(ENVIRONMENT)
})
