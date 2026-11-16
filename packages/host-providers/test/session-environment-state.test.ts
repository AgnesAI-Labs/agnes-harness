import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEnvironment } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
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

it("keeps a session's environment for whoever opens the session next, and removes it with the session", () => {
  const { profileDir, store } = setup()
  expect(store.read('s')).toBeUndefined()
  store.write('s', ENVIRONMENT)
  // Another store over the same profile, as after a restart.
  expect(new SessionEnvironmentStore(profileDir).read('s')).toEqual(ENVIRONMENT)
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
  store.write('s', ENVIRONMENT)
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
  expect(() => store.write('s', { set: { GH_TOKEN: 'x' } })).toThrow(/looks like a credential/)
})
