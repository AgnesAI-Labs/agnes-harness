import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { type SandboxExecutionRecord, SessionSandboxStore } from '../src/profile/sandbox-state.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-sandbox-record-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'test')
  mkdirSync(profileDir, { recursive: true })
  return { profileDir, store: new SessionSandboxStore(profileDir) }
}
const execution: SandboxExecutionRecord = {
  workspaceId: 'workspace',
  workspaceRoot: 'C:\\work',
  policyDigest: 'c'.repeat(64),
  staticConfigHash: 'd'.repeat(64),
  provider: 'local',
  providerVersion: '1',
  target: 'win32',
  implementation: 'unimplemented',
  probeState: 'unprobed',
  backend: 'none',
  enforcement: { level: 'partial', scope: ['file'] },
}
it('persists before execution, survives reopen, and refuses missing historical proof', () => {
  const { profileDir, store } = setup()
  expect(() => store.verify('old', execution, true)).toThrow('create a new session')
  store.verify('new', execution, false)
  expect(() => new SessionSandboxStore(profileDir).verify('new', execution, true)).not.toThrow()
  expect(() => store.verify('new', { ...execution, backend: 'l1' }, true)).toThrow('create a new session')
  store.release('new')
  expect(() => store.verify('new', execution, true)).toThrow('create a new session')
})
it.each(['provider', 'providerVersion', 'target', 'policyDigest', 'workspaceRoot'] as const)(
  'rejects changed %s rather than overwriting the first decision',
  (field) => {
    const { store } = setup()
    store.verify('s', execution, false)
    expect(() => store.verify('s', { ...execution, [field]: 'different' }, false)).toThrow(
      'create a new session',
    )
    store.verify('s', execution, true)
  },
)
it('refuses damaged records and publication failures', () => {
  const { profileDir, store } = setup()
  const directory = join(profileDir, '.session-sandbox')
  mkdirSync(directory)
  const path = join(directory, createHash('sha256').update('s').digest('hex') + '.json')
  writeFileSync(path, '{')
  expect(() => store.verify('s', execution, false)).toThrow('create a new session')
  rmSync(path)
  rmSync(directory, { recursive: true })
  writeFileSync(directory, 'not a directory')
  expect(() => store.verify('s', execution, false)).toThrow()
})
