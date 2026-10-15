import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
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
const isolated: SandboxExecutionRecord = {
  ...execution,
  target: 'darwin',
  implementation: 'implemented',
  probeState: 'ready',
  backend: 'l1',
  enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
}
it.each(['darwin', 'linux'])('adopts missing historical proof under full L1 on %s', (target) => {
  const { profileDir } = setup()
  const log = { info: vi.fn() }
  const store = new SessionSandboxStore(profileDir, log)
  const current = { ...isolated, target }
  store.verify('old', current, true)
  const file = join(
    profileDir,
    '.session-sandbox',
    createHash('sha256').update('old').digest('hex') + '.json',
  )
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    version: 1,
    sessionKey: 'old',
    execution: current,
  })
  expect(log.info).toHaveBeenCalledWith('Adopted missing session execution record under full L1 isolation', {
    sessionHash: createHash('sha256').update('old').digest('hex'),
  })
  new SessionSandboxStore(profileDir).verify('old', current, true)
})
it.each([
  ['native Windows L0', execution],
  ['no backend', { ...isolated, backend: 'none' }],
  ['remote', { ...isolated, backend: 'remote' }],
  ['unimplemented', { ...isolated, implementation: 'unimplemented' }],
  ['unknown implementation', { ...isolated, implementation: 'unknown' }],
  ['failed probe', { ...isolated, probeState: 'failed' }],
  ['unprobed', { ...isolated, probeState: 'unprobed' }],
  ['partial enforcement', { ...isolated, enforcement: { level: 'partial', scope: ['file'] } }],
  ['no enforcement', { ...isolated, enforcement: { level: 'none', scope: ['file'] } }],
  ['no file scope', { ...isolated, enforcement: { level: 'full', scope: ['network', 'process'] } }],
] satisfies Array<[string, SandboxExecutionRecord]>)(
  'refuses missing historical proof with %s',
  (_name, current) => {
    const { profileDir, store } = setup()
    expect(() => store.verify('old', current, true)).toThrow(
      expect.objectContaining({
        code: 'E_SANDBOX_WORKSPACE',
        reason: 'session-execution-record-invalid',
        message:
          'E_SANDBOX_WORKSPACE: saved execution policy is missing or incompatible; keep this history and create a new session',
      }),
    )
    expect(existsSync(join(profileDir, '.session-sandbox'))).toBe(false)
  },
)
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
    store.verify('s', isolated, false)
    expect(() => store.verify('s', { ...isolated, [field]: 'different' }, true)).toThrow(
      'create a new session',
    )
    store.verify('s', isolated, true)
  },
)
it.each([execution, isolated])('refuses damaged records and publication failures (%j)', (current) => {
  const { profileDir, store } = setup()
  const directory = join(profileDir, '.session-sandbox')
  mkdirSync(directory)
  const path = join(directory, createHash('sha256').update('s').digest('hex') + '.json')
  writeFileSync(path, '{')
  expect(() => store.verify('s', current, true)).toThrow('create a new session')
  expect(readFileSync(path, 'utf8')).toBe('{')
  rmSync(path)
  mkdirSync(path)
  expect(() => store.verify('s', current, true)).toThrow('create a new session')
  rmSync(directory, { recursive: true })
  writeFileSync(directory, 'not a directory')
  expect(() => store.verify('s', execution, false)).toThrow()
})
