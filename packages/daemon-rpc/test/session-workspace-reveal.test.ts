import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { MemorySessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { resolveWorkspaceDirectory } from '@agnes/host'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requireSessionOwner } from '../src/local/methods/agnes.js'
import {
  desktopAvailable,
  registerSessionWorkspaceReveal,
  registerWorkspaceReveal,
} from '../src/local/methods/session-workspace-reveal.js'

const { spawn, failure, desktop } = vi.hoisted(() => ({
  spawn: vi.fn(),
  failure: { current: false },
  desktop: { name: 'Aqua', failure: false },
}))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = (file: string, ...args: unknown[]) => {
    if (file !== '/bin/launchctl') return Reflect.apply(actual.execFile, undefined, [file, ...args])
    const callback = args.at(-1)
    if (typeof callback !== 'function') throw new Error('Expected launchctl callback')
    queueMicrotask(() => callback(desktop.failure ? new Error('probe failed') : null, desktop.name, ''))
  }
  // Host's native helper uses the original promisified execFile contract.
  Object.defineProperty(execFile, promisify.custom, { value: Reflect.get(actual.execFile, promisify.custom) })
  return { ...actual, spawn, execFile }
})
let directory: string
let root: string
let endpoint: LocalEndpoint
let workspaces: WorkspaceCatalog
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agnes-reveal-'))
  // Shell metacharacters stay a single, literal argv entry.
  root = join(directory, 'project; $(literal)')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(root)
  workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    resolveWorkspaceDirectory,
  )
  await workspaces.add(root)
  await workspaces.authorizeAndBind('owned', root)
  endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  endpoint.conn.initialized = true
  endpoint.conn.authKind = 'local'
  endpoint.conn.credentialKind = 'local'
  failure.current = false
  desktop.name = 'Aqua'
  desktop.failure = false
  spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    queueMicrotask(() => child.emit(failure.current ? 'error' : 'spawn', new Error('opener missing')))
    return child
  })
})
afterEach(async () => {
  await endpoint.close()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})
const call = (params: unknown = { sessionId: 'owned' }) =>
  endpoint.handle({
    jsonrpc: '2.0',
    id: 1,
    method: '_agnes/v1/session.revealWorkspace',
    params,
  })
function register(platform = 'darwin', local = true, environment = {}) {
  const owners = new MemorySessionPrincipalOwnership()
  for (const id of ['owned', 'unbound']) {
    owners.bindNew(id, 'local')
    owners.activateNew(id, 'local')
  }
  owners.bindNew('foreign', 'other')
  owners.activateNew('foreign', 'other')
  registerSessionWorkspaceReveal(
    endpoint,
    workspaces,
    requireSessionOwner({
      workspaces,
      sessionOwnership: owners,
      registry: {
        get: () => undefined,
        open: async () => {
          throw new Error('Unexpected registry open')
        },
        fork: async () => {
          throw new Error('Unexpected registry fork')
        },
        require: () => {
          throw new Error('Unexpected registry require')
        },
        subscribe: () => () => {},
        subscribePreview: () => () => {},
        previewSnapshot: async () => [],
        keys: () => [],
        close: async () => {},
        closeAll: async () => {},
      },
    }),
    { local, platform, environment },
  )
}

it.each([
  ['darwin', {}, 'open'],
  ['win32', { SESSIONNAME: 'Console' }, 'explorer.exe'],
  ['linux', { DISPLAY: ':0' }, 'xdg-open'],
])('opens only the authoritative root with the %s native argv', async (platform, env, executable) => {
  register(platform, true, env)
  expect(await call()).toMatchObject({ result: { opened: true } })
  expect(spawn).toHaveBeenCalledWith(executable, [workspaces.sessionPath('owned')], {
    detached: true,
    stdio: 'ignore',
    shell: false,
  })
  expect(await call({ sessionId: 'owned', path: '/client-chosen' })).toHaveProperty('error.code', -32602)
})

it.each([
  'unknown',
  'foreign',
  'unbound',
  'missing',
  'remote',
  'remote-identity',
  'wrong-credential',
  'headless',
  'opener',
])('refuses %s without substituting another workspace', async (scenario) => {
  register('linux', scenario !== 'remote', scenario === 'headless' ? {} : { DISPLAY: ':0' })
  if (scenario === 'missing') await rm(root, { recursive: true })
  if (scenario === 'remote-identity') endpoint.conn.authKind = 'jwt'
  if (scenario === 'wrong-credential') endpoint.conn.credentialKind = 'jwt'
  if (scenario === 'opener') failure.current = true
  const sessionId = ['unknown', 'foreign', 'unbound'].includes(scenario) ? scenario : 'owned'
  const response = await call({ sessionId })
  expect(response).toHaveProperty('error')
  if (scenario === 'unknown') expect(response).toHaveProperty('error.data.code', 'SESSION_NOT_FOUND')
  if (['remote', 'remote-identity', 'foreign', 'wrong-credential'].includes(scenario))
    expect(response).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
  if (scenario !== 'opener') expect(spawn).not.toHaveBeenCalled()
})

it('requires initialization and recognizes headless/SSH desktops across native platforms', async () => {
  register()
  endpoint.conn.initialized = false
  expect(await call()).toHaveProperty('error.data.code', 'NOT_INITIALIZED')
  for (const platform of ['darwin', 'win32', 'linux']) {
    expect(
      desktopAvailable(platform, { SSH_CONNECTION: 'remote', DISPLAY: ':0', SESSIONNAME: 'Console' }),
    ).toBe(false)
    expect(desktopAvailable(platform, { CI: 'true' })).toBe(false)
  }
  expect(desktopAvailable('win32', { SESSIONNAME: 'Services' })).toBe(false)
  expect(desktopAvailable('linux', {})).toBe(false)
  expect(desktopAvailable('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true)
  expect(desktopAvailable('freebsd', {})).toBe(false)
  expect(spawn).not.toHaveBeenCalled()
})

it.each(['Background', 'System', 'LoginWindow', 'probe failure'])(
  'refuses the macOS %s bootstrap without launching an opener',
  async (bootstrap) => {
    register()
    desktop.name = bootstrap
    desktop.failure = bootstrap === 'probe failure'
    expect(await call({ sessionId: 'foreign' })).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    expect(await call()).toHaveProperty('error.data.code', 'DESKTOP_UNAVAILABLE')
    expect(spawn).not.toHaveBeenCalled()
  },
)

it('does not launch a desktop opener after the requesting connection closes during workspace validation', async () => {
  register()
  const binding = await workspaces.restoreBinding('owned')
  let release: (() => void) | undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const validate = vi.spyOn(workspaces, 'restoreBinding').mockImplementation(async () => {
    await wait
    return binding
  })
  const request = call()
  await vi.waitFor(() => expect(validate).toHaveBeenCalled())
  const close = endpoint.close()
  release?.()
  await Promise.all([request, close])
  expect(spawn).not.toHaveBeenCalled()
})

it.each([
  ['darwin', {}, 'open'],
  ['win32', { SESSIONNAME: 'Console' }, 'explorer.exe'],
  ['linux', { DISPLAY: ':0' }, 'xdg-open'],
])(
  'reveals only listed projects on %s without requiring a session',
  async (platform, environment, executable) => {
    registerWorkspaceReveal(endpoint, workspaces, { local: true, platform, environment })
    const callWorkspace = (params: unknown) =>
      endpoint.handle({ jsonrpc: '2.0', id: 2, method: '_agnes/v1/workspace.reveal', params })
    const {
      items: [workspace],
    } = await workspaces.list()
    expect(workspace).toBeDefined()
    expect(await callWorkspace({ path: root })).toMatchObject({ result: { opened: true } })
    expect(await callWorkspace({ workspaceId: workspace?.workspaceId })).toMatchObject({
      result: { opened: true },
    })
    expect(spawn).toHaveBeenLastCalledWith(executable, [workspace?.path], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    })
    spawn.mockClear()
    expect(await callWorkspace({ workspaceId: 'a'.repeat(64) })).toHaveProperty(
      'error.data.code',
      'WORKSPACE_NOT_FOUND',
    )
    expect(await callWorkspace({ path: directory })).toHaveProperty('error.data.code', 'WORKSPACE_NOT_FOUND')
    endpoint.conn.authKind = 'jwt'
    expect(await callWorkspace({ path: root })).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
    endpoint.conn.authKind = 'local'
    if (!workspace?.workspaceId) throw new Error('missing workspace id')
    workspaces.remove(workspace.workspaceId, undefined, { running: () => false, archive: () => {} })
    expect(await callWorkspace({ path: root })).toHaveProperty('error.data.code', 'WORKSPACE_NOT_FOUND')
    await workspaces.add(root)
    await rm(root, { recursive: true })
    expect(await callWorkspace({ workspaceId: workspace.workspaceId })).toHaveProperty(
      'error.data.code',
      'WORKSPACE_STALE',
    )
    expect(spawn).not.toHaveBeenCalled()
  },
)
