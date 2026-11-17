import { beforeEach, expect, it, vi } from 'vitest'
import type { LocalBackend } from './backend.js'

/**
 * Verifies `localOAuthAdmin`'s own wiring logic: `login` forwards to the daemon's
 * `admin.mcp.oauth.get` / `admin.mcp.oauth.complete`, `onAuthorizationStatus` forwards to
 * `mcp.servers.oauth.status.set` (and reconnects after a sign-in), and `startAuthorization` is
 * forwarded out of the returned object. It deliberately does not re-drive a real HTTP oauth flow (that would duplicate
 * packages/resource-control-runtime/test/oauth-http-handler.test.ts's own, much larger fixture) -
 * `@agnes/resource-control-runtime`'s `createOAuthHttpHandler` is mocked so this file can capture
 * exactly the options `localOAuthAdmin` passes it and invoke `onAuthorizationStatus` directly, the
 * same "mock @agnes/sdk's createClient, capture what the admin wrapper handed to the next layer down"
 * pattern package-admin.test.ts already uses for `localPackageAdmin`/`createAdminSurface` - no new
 * test-driving mechanism introduced.
 */
const mocks = vi.hoisted(() => {
  const close = vi.fn(async () => undefined)
  const request = vi.fn(async () => ({}))
  const mcpServersGet = vi.fn(async () => ({
    revision: 'r'.repeat(64),
    definition: {
      serverId: 'srv-1',
      transport: { kind: 'http', url: 'https://mcp.example.test/api' },
      secretBinding: { kind: 'oauth', staticClientId: 'static-client-id' },
    },
  }))
  const oauthStatusSet = vi.fn(async () => ({ authorizationStatus: 'authorized' }))
  const reconnect = vi.fn(async () => ({ operationId: 'op-1', state: 'queued' }))
  const createOAuthHttpHandler = vi.fn((_opts: Record<string, unknown>) =>
    Object.assign(vi.fn(), {
      startAuthorization: vi.fn(async () => ({ authorizeUrl: 'https://example.test/' })),
    }),
  )
  return { close, request, mcpServersGet, oauthStatusSet, reconnect, createOAuthHttpHandler }
})

vi.mock('@agnes/sdk', () => ({
  unixTransport: vi.fn(),
  memoryJournal: vi.fn(() => ({})),
  createClient: vi.fn(() => ({
    initialize: vi.fn(async () => ({})),
    close: mocks.close,
    request: mocks.request,
    clientId: vi.fn(async () => 'client-launch'),
    mcp: {
      servers: {
        get: mocks.mcpServersGet,
        reconnect: mocks.reconnect,
        oauth: { statusSet: mocks.oauthStatusSet },
      },
    },
  })),
}))

vi.mock('@agnes/resource-control-runtime', () => ({ createOAuthHttpHandler: mocks.createOAuthHttpHandler }))

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

it('reads the sign-in summary and hands the completion to the daemon with the launch profile', async () => {
  const backend = fakeBackend()
  localOAuthAdmin(backend, new URL('http://127.0.0.1:4177'))
  const opts = mocks.createOAuthHttpHandler.mock.calls[0]?.[0] as
    | {
        login: {
          get(serverId: string): Promise<unknown>
          complete(params: Record<string, unknown>): Promise<void>
        }
      }
    | undefined

  mocks.request.mockResolvedValueOnce({
    epoch: 2,
    signedIn: false,
    refreshable: false,
    scope: [],
    requiredScope: [],
  })
  expect(await opts?.login.get('srv-1')).toMatchObject({ epoch: 2 })
  expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/admin.mcp.oauth.get', {
    profile: 'local-dev',
    serverId: 'srv-1',
  })

  const params = {
    serverId: 'srv-1',
    expectedEpoch: 2,
    code: 'code-1',
    codeVerifier: 'v'.repeat(43),
    redirectUri: 'http://127.0.0.1:4177/oauth/srv-1/callback',
    client: { clientId: 'dcr-client', clientSecret: 'dcr-secret' },
    requestedScope: ['read'],
  }
  await opts?.login.complete(params)
  expect(mocks.request).toHaveBeenCalledWith('_agnes/v1/admin.mcp.oauth.complete', {
    ...params,
    profile: 'local-dev',
  })
  expect(mocks.request).not.toHaveBeenCalledWith('_agnes/v1/admin.mcp.oauth.save', expect.anything())
})

it('marks the server authorized after a sign-in and reconnects it at its current revision', async () => {
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
  expect(mocks.reconnect).toHaveBeenCalledWith(
    expect.objectContaining({
      profile: 'local-dev',
      serverId: 'srv-1',
      expectedRevision: 'r'.repeat(64),
      clientId: 'client-launch',
      commandId: expect.stringMatching(/^mcp-oauth-reconnect-/),
    }),
  )
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
  expect(mocks.reconnect).not.toHaveBeenCalled()
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
