import { connect, createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpLoginPortBusy } from '../../src/mcp-login/loopback.js'
import { McpLoginRefused } from '../../src/mcp-login/paste.js'
import { mcpLoginFailureText, runMcpLogin, runMcpLogout } from '../../src/mcp-login/run.js'
import {
  browserReturning,
  type FakeDaemonOptions,
  fakeAuthorizationServer,
  fakeDaemon,
} from './fake-daemon.js'

type Shown = { authorizationUrl: URL; redirectUri: string; state: string }

function loginUi(paste?: (shown: Shown) => Promise<string | undefined>) {
  let reveal: (shown: Shown) => void = () => undefined
  const shown = new Promise<Shown>((resolve) => {
    reveal = resolve
  })
  const progress: string[] = []
  const ui = {
    show(input: { serverId: string; authorizationUrl: string }) {
      const authorizationUrl = new URL(input.authorizationUrl)
      reveal({
        authorizationUrl,
        redirectUri: authorizationUrl.searchParams.get('redirect_uri') as string,
        state: authorizationUrl.searchParams.get('state') as string,
      })
    },
    async paste(signal: AbortSignal) {
      const seen = await shown
      if (paste) return paste(seen)
      return new Promise<undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined)))
    },
    progress(text: string) {
      progress.push(text)
    },
  }
  return { ui, shown, progress }
}

function login(
  options: FakeDaemonOptions,
  extra: { paste?: (shown: Shown) => Promise<string | undefined>; open?: (url: string) => void } = {},
) {
  const daemon = fakeDaemon(options)
  const network = fakeAuthorizationServer()
  const { ui, shown, progress } = loginUi(extra.paste)
  const browser = browserReturning('code-1')
  const outcome = runMcpLogin({
    client: daemon.client,
    profile: 'local-dev',
    serverId: 'docs',
    ui,
    signal: new AbortController().signal,
    fetchImpl: network.fetchImpl,
    openBrowser: extra.open ?? browser.open,
  })
  return { daemon, network, shown, progress, outcome, browser }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (!address || typeof address === 'string') throw new Error('no port')
  return address.port
}

const signInCalls = [
  '_agnes/v1/admin.mcp.oauth.complete',
  'mcp.servers.oauth.statusSet',
  'mcp.servers.get',
  'mcp.servers.reconnect',
]

afterEach(() => {
  vi.useRealTimers()
})

describe('terminal MCP sign-in', () => {
  it('browser callback completes the login, then marks it authorized and reconnects', async () => {
    const t = login({})
    expect(await t.outcome).toEqual({ kind: 'signed-in' })
    const { redirectUri, state, authorizationUrl } = await t.shown
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(t.browser.visits).toEqual([authorizationUrl.href])
    expect(t.daemon.params('_agnes/v1/admin.mcp.oauth.complete')).toMatchObject({
      profile: 'local-dev',
      serverId: 'docs',
      expectedEpoch: 0,
      code: 'code-1',
      redirectUri,
      client: { clientId: 'dcr-client' },
      authorization: {
        tokenEndpoint: 'https://auth.example.test/token',
        resource: 'https://mcp.example.test/mcp',
      },
    })
    expect(t.daemon.names().slice(-4)).toEqual(signInCalls)
    expect(t.daemon.params('mcp.servers.oauth.statusSet')).toMatchObject({ status: 'authorized' })
    expect(t.daemon.params('mcp.servers.reconnect')).toMatchObject({
      profile: 'local-dev',
      serverId: 'docs',
      expectedRevision: 'a'.repeat(64),
      clientId: 'cli-client',
    })
  })

  it('a pasted full URL completes the login', async () => {
    const t = login(
      {},
      { open: () => undefined, paste: async (s) => `${s.redirectUri}?code=pasted&state=${s.state}` },
    )
    expect(await t.outcome).toEqual({ kind: 'signed-in' })
    expect(t.daemon.params('_agnes/v1/admin.mcp.oauth.complete')).toMatchObject({ code: 'pasted' })
  })

  it('a wrong paste ends the sign-in with an error and spends nothing', async () => {
    const t = login({}, { open: () => undefined, paste: async () => 'code-only' })
    await expect(t.outcome).rejects.toThrow(/full address/)
    expect(t.daemon.names()).not.toContain('_agnes/v1/admin.mcp.oauth.complete')
  })

  it('an empty paste cancels', async () => {
    const t = login({}, { open: () => undefined, paste: async () => '' })
    expect(await t.outcome).toEqual({ kind: 'cancelled' })
    expect(t.daemon.names()).not.toContain('_agnes/v1/admin.mcp.oauth.complete')
  })

  it('an error on the browser callback is reported', async () => {
    const t = login({}, { open: browserReturning(undefined, '&error=access_denied').open })
    await expect(t.outcome).rejects.toBeInstanceOf(McpLoginRefused)
  })

  it('times out after 5 minutes and closes the listener', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = login({}, { open: () => undefined })
    const { redirectUri } = await t.shown
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    let settled = false
    void t.outcome.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await t.outcome).toEqual({ kind: 'timed-out' })
    vi.useRealTimers()
    const port = Number(new URL(redirectUri).port)
    await expect(
      new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => resolve(socket.end()))
        socket.once('error', reject)
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect(t.daemon.names()).not.toContain('_agnes/v1/admin.mcp.oauth.complete')
  })

  it('a refreshable token skips the browser', async () => {
    const t = login({ summary: { signedIn: true, refreshable: true }, refresh: { signedIn: true } })
    expect(await t.outcome).toEqual({ kind: 'already-signed-in' })
    expect(t.browser.visits).toEqual([])
    expect(t.network.paths).toEqual([])
    expect(t.daemon.names()).toEqual([
      'mcp.servers.get',
      '_agnes/v1/admin.mcp.oauth.get',
      '_agnes/v1/admin.mcp.oauth.refresh',
      'mcp.servers.oauth.statusSet',
      'mcp.servers.get',
      'mcp.servers.reconnect',
    ])
  })

  it('a refresh the server refuses goes to the browser', async () => {
    const t = login({ summary: { signedIn: true, refreshable: true }, refresh: { signedIn: false } })
    expect(await t.outcome).toEqual({ kind: 'signed-in' })
    expect(t.daemon.names()).toContain('_agnes/v1/admin.mcp.oauth.complete')
  })

  it('pending requiredScope goes to the browser even when refreshable', async () => {
    const t = login({
      summary: { signedIn: true, refreshable: true, requiredScope: ['write'] },
      refresh: { signedIn: true },
    })
    expect(await t.outcome).toEqual({ kind: 'signed-in' })
    expect(t.daemon.names()).not.toContain('_agnes/v1/admin.mcp.oauth.refresh')
  })

  it('a none-binding server switches to oauth after sign-in, then reconnects', async () => {
    const t = login({ secretBinding: { kind: 'none' } })
    expect(await t.outcome).toEqual({ kind: 'signed-in' })
    expect(t.daemon.names().slice(-5)).toEqual([
      '_agnes/v1/admin.mcp.oauth.complete',
      'mcp.servers.update',
      ...signInCalls.slice(1),
    ])
    expect(t.daemon.params('mcp.servers.update')).toMatchObject({
      expectedRevision: 'a'.repeat(64),
      definition: { serverId: 'docs', transport: { kind: 'http' }, secretBinding: { kind: 'oauth' } },
      clientId: 'cli-client',
    })
    expect(t.daemon.params('mcp.servers.reconnect')).toMatchObject({ expectedRevision: 'b'.repeat(64) })
  })

  it.each(['failed', 'throws'] as const)(
    'a reconnect that %s is reported, and the sign-in still counts',
    async (reconnect) => {
      const t = login({ reconnect })
      const outcome = await t.outcome
      expect(outcome.kind).toBe('signed-in')
      expect(outcome.reconnectFailed).toMatch(
        reconnect === 'failed' ? /could not connect/ : /daemon went away/,
      )
    },
  )

  it('a stdio server is refused', async () => {
    const t = login({ transport: { kind: 'stdio', executable: 'docs-mcp', args: [] } })
    await expect(t.outcome).rejects.toThrow('"docs" is not an HTTP server')
  })

  it('a server with a bearer credential is refused', async () => {
    const t = login({ secretBinding: { kind: 'http-bearer', ref: 'secret://mcp/docs' } })
    await expect(t.outcome).rejects.toThrow(/bearer or header credential/)
  })

  it('a fixed callback port from the server settings is used', async () => {
    const port = await freePort()
    const t = login({ secretBinding: { kind: 'oauth', callbackPort: port } })
    expect(await t.outcome).toEqual({ kind: 'signed-in' })
    expect((await t.shown).redirectUri).toBe(`http://localhost:${port}/callback`)
  })

  it('fixed callbackPort busy: error, no other port', async () => {
    const busy = createServer()
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve))
    const port = (busy.address() as { port: number }).port
    try {
      const t = login({ secretBinding: { kind: 'oauth', callbackPort: port } })
      await expect(t.outcome).rejects.toBeInstanceOf(McpLoginPortBusy)
      expect(t.network.paths).toEqual([])
    } finally {
      await new Promise((resolve) => busy.close(resolve))
    }
  })

  it('the port of a stored registration is reused, so no new registration is needed', async () => {
    const port = await freePort()
    const redirectUri = `http://localhost:${port}/callback`
    const t = login({ summary: { client: { clientId: 'kept-client', redirectUri } } })
    expect(await t.outcome).toEqual({ kind: 'signed-in' })
    expect((await t.shown).redirectUri).toBe(redirectUri)
    expect(t.network.paths).not.toContain('https://auth.example.test/register')
    expect(t.daemon.params('_agnes/v1/admin.mcp.oauth.complete')).toMatchObject({
      client: { clientId: 'kept-client' },
    })
  })

  it('a refused completion is reported in plain words', async () => {
    const t = login({
      completeError: { data: { code: 'SEMANTIC_REJECTED', reason: 'MCP_OAUTH_LOGIN_SUPERSEDED' } },
    })
    await expect(t.outcome).rejects.toThrow('"docs" was signed out during sign-in; run the command again')
    expect(t.daemon.names()).not.toContain('mcp.servers.reconnect')
  })

  it.each([
    [{ reason: 'MCP_OAUTH_LOGIN_ENDPOINT_CHANGED' }, /OAuth settings of "docs" changed during sign-in/],
    [{ reason: 'MCP_OAUTH_DISCOVERY_FAILED' }, /OAuth settings of "docs" could not be read/],
    [{ reason: 'MCP_OAUTH_GRANT_REJECTED' }, /refused the sign-in code/],
    [
      { reason: 'MCP_OAUTH_CLIENT_AUTH_UNSUPPORTED', method: 'private_key_jwt' },
      /does not support: private_key_jwt/,
    ],
    [{ reason: 'CONFIG_CREDENTIAL_NOT_FOUND' }, /client secret of "docs" is not in the credential store/],
  ])('reason %o reads as a sentence', (data, sentence) => {
    expect(mcpLoginFailureText('docs', { data: { code: 'SEMANTIC_REJECTED', ...data } })).toMatch(sentence)
  })

  it('logout calls logout then signOut', async () => {
    const daemon = fakeDaemon()
    await runMcpLogout({ client: daemon.client, profile: 'local-dev', serverId: 'docs' })
    expect(daemon.names()).toEqual([
      'mcp.servers.get',
      '_agnes/v1/admin.mcp.oauth.logout',
      'mcp.servers.oauth.signOut',
    ])
    expect(daemon.params('mcp.servers.oauth.signOut')).toMatchObject({
      profile: 'local-dev',
      serverId: 'docs',
      expectedRevision: 'a'.repeat(64),
      clientId: 'cli-client',
    })
  })

  it('logout of a server without OAuth settings only forgets the stored sign-in', async () => {
    const daemon = fakeDaemon({ secretBinding: { kind: 'none' } })
    await runMcpLogout({ client: daemon.client, profile: 'local-dev', serverId: 'docs' })
    expect(daemon.names()).toEqual(['mcp.servers.get', '_agnes/v1/admin.mcp.oauth.logout'])
  })
})
