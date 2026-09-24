import { beforeEach, expect, it, vi } from 'vitest'
import type { LocalBackend } from './backend.js'

/**
 * Task 5 (mcp-oauth-authorization plan): verifies `localOAuthAdmin`'s own wiring logic - the part
 * of this file this task actually changes (`onAuthorizationStatus` now forwards to the daemon's new
 * `mcp.servers.oauth.status.set` RPC method, and `startAuthorization` is now forwarded out of the
 * returned object). It deliberately does not re-drive a real HTTP oauth flow (that would duplicate
 * packages/resource-control-runtime/test/oauth-http-handler.test.ts's own, much larger fixture) -
 * `@agnes/resource-control-runtime`'s `createOAuthHttpHandler` is mocked so this file can capture
 * exactly the options `localOAuthAdmin` passes it and invoke `onAuthorizationStatus` directly, the
 * same "mock @agnes/sdk's createClient, capture what the admin wrapper handed to the next layer down"
 * pattern package-admin.test.ts already uses for `localPackageAdmin`/`createAdminSurface` - no new
 * test-driving mechanism introduced.
 */
const mocks = vi.hoisted(() => {
  const close = vi.fn(async () => undefined)
  const mcpServersGet = vi.fn(async () => ({
    definition: {
      serverId: 'srv-1',
      transport: { kind: 'http', url: 'https://mcp.example.test/api' },
      secretBinding: { kind: 'oauth', staticClientId: 'static-client-id' },
    },
  }))
  const oauthStatusSet = vi.fn(async () => ({ authorizationStatus: 'authorized' }))
  const createOAuthHttpHandler = vi.fn((_opts: Record<string, unknown>) =>
    Object.assign(vi.fn(), {
      startAuthorization: vi.fn(async () => ({ authorizeUrl: 'https://example.test/' })),
    }),
  )
  return { close, mcpServersGet, oauthStatusSet, createOAuthHttpHandler }
})

vi.mock('@agnes/sdk', () => ({
  memoryJournal: vi.fn(() => ({})),
  createClient: vi.fn(() => ({
    initialize: vi.fn(async () => ({})),
    close: mocks.close,
    mcp: { servers: { get: mocks.mcpServersGet, oauth: { statusSet: mocks.oauthStatusSet } } },
  })),
}))

vi.mock('@agnes/resource-control-runtime', () => ({ createOAuthHttpHandler: mocks.createOAuthHttpHandler }))

vi.mock('@agnes/host', () => ({ createCredentialStore: vi.fn(() => ({ putOAuth: vi.fn() })) }))

import { localOAuthAdmin } from './oauth-admin.js'

beforeEach(() => vi.clearAllMocks())

function fakeBackend(): LocalBackend {
  return {
    scope: { profile: 'local-dev', scopeID: 'scope-1', home: '/tmp/agnes-home' },
    socketPath: '/tmp/agnes-test.sock',
    web: {
      url: 'ws://127.0.0.1:5000',
      origin: 'http://127.0.0.1:4177',
      token: 'local-web-token-with-enough-entropy',
    },
  } as unknown as LocalBackend
}

it('wires onAuthorizationStatus to the daemon oauth.status.set RPC method, closing the Task 4 gap', async () => {
  const backend = fakeBackend()
  localOAuthAdmin(backend, new URL('http://127.0.0.1:4177'))

  const opts = mocks.createOAuthHttpHandler.mock.calls[0]?.[0] as
    | { onAuthorizationStatus?(serverId: string, status: string): Promise<void> }
    | undefined
  expect(opts?.onAuthorizationStatus).toBeTypeOf('function')

  await opts?.onAuthorizationStatus?.('srv-1', 'authorized')

  expect(mocks.oauthStatusSet).toHaveBeenCalledWith({
    profile: 'local-dev',
    serverId: 'srv-1',
    status: 'authorized',
  })
})

it('forwards the daemon-reported status verbatim for every outcome a callback can report', async () => {
  const backend = fakeBackend()
  localOAuthAdmin(backend, new URL('http://127.0.0.1:4177'))
  const opts = mocks.createOAuthHttpHandler.mock.calls[0]?.[0] as
    | { onAuthorizationStatus?(serverId: string, status: string): Promise<void> }
    | undefined

  await opts?.onAuthorizationStatus?.('srv-1', 'needs-reconnect')
  await opts?.onAuthorizationStatus?.('srv-1', 'error')

  expect(mocks.oauthStatusSet).toHaveBeenNthCalledWith(1, {
    profile: 'local-dev',
    serverId: 'srv-1',
    status: 'needs-reconnect',
  })
  expect(mocks.oauthStatusSet).toHaveBeenNthCalledWith(2, {
    profile: 'local-dev',
    serverId: 'srv-1',
    status: 'error',
  })
})

it('exposes startAuthorization on the returned object, forwarded from the underlying handler', async () => {
  const backend = fakeBackend()
  const admin = localOAuthAdmin(backend, new URL('http://127.0.0.1:4177'))

  const result = await admin.startAuthorization('srv-1')

  expect(result).toEqual({ authorizeUrl: 'https://example.test/' })
})

it('resolveServer still reads the target server via mcp.servers.get, unaffected by this wiring', async () => {
  const backend = fakeBackend()
  localOAuthAdmin(backend, new URL('http://127.0.0.1:4177'))
  const opts = mocks.createOAuthHttpHandler.mock.calls[0]?.[0] as
    | { resolveServer(serverId: string): Promise<unknown> }
    | undefined

  const info = await opts?.resolveServer('srv-1')

  expect(mocks.mcpServersGet).toHaveBeenCalledWith({ profile: 'local-dev', serverId: 'srv-1' })
  expect(info).toEqual({
    serverUrl: new URL('https://mcp.example.test/api'),
    staticClientId: 'static-client-id',
  })
})
