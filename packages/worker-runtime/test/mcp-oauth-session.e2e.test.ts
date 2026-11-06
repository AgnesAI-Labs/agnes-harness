import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mcpStablePrefix } from '@agnes/base'
import { createMcpOAuthStore, type Host, type McpOAuthStore } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { McpServerDefinitionInput } from '@agnes/protocol'
import {
  completeMcpOAuthLogin,
  createMcpOAuthAuthorizer,
  createOAuthHttpHandler,
  signOutMcpOAuth,
  summarizeMcpOAuth,
} from '@agnes/resource-control-runtime'
import { createWorkerMcpServerOpener } from '@agnes/resource-control-worker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpRowRuntime } from '../src/mcp-row-runtime.js'
import type { McpServerSnapshotEntry } from '../src/mcp-server-rows.js'

/**
 * OAuth MCP servers in a session worker, end to end: the web sign-in writes the credential record,
 * the session-row opener reads it per request through the real credential store, and a real Host
 * lists and calls the server's tool. One `node:http` fixture plays the MCP server (Streamable HTTP)
 * and its authorization server on the same origin, without authorization server metadata, so the
 * token endpoint is `<origin>/token` and no TLS is needed.
 */

const require = createRequire(import.meta.url)
const baseRequire = createRequire(join(dirname(dirname(require.resolve('@agnes/base'))), 'package.json'))
const { Server } = baseRequire('@modelcontextprotocol/sdk/server/index.js')
const { StreamableHTTPServerTransport } = baseRequire('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = baseRequire('@modelcontextprotocol/sdk/types.js')

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const SERVER_ID = 'docs'
const CLIENT_ID = 'agnes-session-test'
const TOOL = `${mcpStablePrefix(SERVER_ID)}echo`

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function listen(server: HttpServer): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing fixture address')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function closeServer(server: HttpServer): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

type Event = Readonly<
  | { kind: 'mcp'; method: string; authorization?: string; status: number }
  | { kind: 'token'; grant: string; form: Record<string, string> }
>

/** The MCP server and its authorization server. Tokens in `revoked` are answered with a 401. */
async function startRemote() {
  const events: Event[] = []
  const revoked = new Set<string>()
  let refuseAll = false
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  let issued = 0

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authorization = req.headers.authorization
    const token = authorization?.replace(/^Bearer /, '')
    const refused = !token || refuseAll || revoked.has(token)
    // No standalone event stream: the client takes 405 as "not offered".
    const status = refused ? 401 : req.method === 'GET' ? 405 : 200
    events.push({
      kind: 'mcp',
      method: req.method ?? '',
      ...(authorization ? { authorization } : {}),
      status,
    })
    if (status !== 200) {
      res
        .writeHead(status, status === 401 ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {})
        .end()
      return
    }
    const server = new Server(
      { name: 'oauth-session-fixture', version: '1' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: 'echoed' }],
    }))
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)))
    const grant = form.grant_type ?? ''
    events.push({ kind: 'token', grant, form })
    const send = (status: number, body: object): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    if (grant === 'authorization_code') {
      const pending = codes.get(form.code ?? '')
      const challenge = createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url')
      if (!pending || pending.challenge !== challenge || pending.redirectUri !== form.redirect_uri)
        return send(400, { error: 'invalid_grant' })
      codes.delete(form.code ?? '')
    } else if (grant !== 'refresh_token') return send(400, { error: 'unsupported_grant_type' })
    issued += 1
    send(200, {
      access_token: `at-${issued}`,
      refresh_token: `rt-${issued}`,
      token_type: 'Bearer',
      expires_in: 3600,
    })
  }

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const done = (work: Promise<void>) => void work.catch((error) => res.writeHead(500).end(String(error)))
    if (url.pathname === '/mcp') return done(mcp(req, res))
    if (url.pathname === '/token' && req.method === 'POST') return done(token(req, res))
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? ''
      const challenge = url.searchParams.get('code_challenge') ?? ''
      if (url.searchParams.get('code_challenge_method') !== 'S256' || !redirectUri || !challenge)
        return void res.writeHead(400).end()
      const code = randomBytes(8).toString('hex')
      codes.set(code, { challenge, redirectUri })
      const back = new URL(redirectUri)
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state') ?? '')
      return void res.writeHead(302, { location: back.href }).end()
    }
    res.writeHead(404).end()
  })
  const origin = await listen(http)
  cleanup.push(() => closeServer(http))
  const mcpEvents = () => events.filter((event) => event.kind === 'mcp')
  return {
    mcpUrl: `${origin}/mcp`,
    events,
    mcpEvents,
    refreshGrants: () => events.filter((event) => event.kind === 'token' && event.grant === 'refresh_token'),
    revoke: (value: string) => revoked.add(value),
    refuseEveryToken: () => {
      refuseAll = true
    },
  }
}
type Remote = Awaited<ReturnType<typeof startRemote>>

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Writes a signed-in record the way a completed sign-in leaves it. */
async function seedSignIn(
  store: McpOAuthStore,
  remote: Remote,
  tokens: { access: string; expiresAt: number },
) {
  await store.update(SERVER_ID, async () => ({
    value: undefined,
    next: {
      epoch: 0,
      client: { clientId: CLIENT_ID, redirectUri: 'http://localhost:1/callback' },
      server: {
        endpoint: remote.mcpUrl,
        authorizationServer: new URL('/', remote.mcpUrl).href,
        tokenEndpoint: new URL('/token', remote.mcpUrl).href,
        resource: remote.mcpUrl,
      },
      tokens: { accessToken: tokens.access, refreshToken: 'rt-0', expiresAt: tokens.expiresAt, scope: [] },
      requiredScope: [],
    },
  }))
}

/** A real Host whose MCP rows come from the session-row opener, reading `store`. */
async function sessionRows(store: McpOAuthStore, remote: Remote) {
  const dataDir = await tempRoot('mcp-oauth-session-')
  const { host } = await createTestHost({
    dataDir,
    disableSessionTitle: true,
    packageDirs: { '@agnes/base': baseDir },
  })
  cleanup.push(() => host.close())
  const runtime = createMcpRowRuntime({
    host,
    opener: createWorkerMcpServerOpener({
      env: {
        AGNES_RESOURCE_MCP_POLICY: JSON.stringify({
          allowedExecutables: [],
          allowLoopbackHttp: true,
          localDaemon: true,
        }),
      },
      profile: { name: 'local-dev', dataDir } as never,
      createSecrets: () => {
        throw new Error('a static client without a secret must not resolve secrets')
      },
      createMcpOAuthStore: () => store,
    }),
  })
  cleanup.push(() => runtime.apply([]))
  const entry: McpServerSnapshotEntry = {
    definition: {
      serverId: SERVER_ID,
      displayName: 'Docs',
      transport: { kind: 'http', url: remote.mcpUrl },
      secretBinding: { kind: 'oauth', staticClientId: CLIENT_ID },
    } as McpServerDefinitionInput,
    revision: 'r1',
    desired: 'enabled',
    trust: 'trusted',
  }
  const applied = await runtime.apply([entry])
  const session = await host.createSession({ key: 'oauth-session', cwd: dataDir })
  const call = async () => {
    const resolved = session.currentTools().resolve(TOOL) as unknown as {
      execute(args: unknown, ctx: unknown): Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    }
    return resolved.execute(
      {},
      {
        signal: new AbortController().signal,
        session: { key: session.key, lane: session.lane, workspaceRoot: dataDir },
      },
    )
  }
  return { host, runtime, entry, applied, call }
}

const tool = (host: Host) => host.kernel.tools.resolve(TOOL)
const lastText = (result: { content: Array<{ text: string }> }) => result.content.at(-1)?.text ?? ''

describe('OAuth MCP servers in session rows', () => {
  it('web sign-in then a session row lists and calls the tool', async () => {
    const remote = await startRemote()
    const store = createMcpOAuthStore({ root: await tempRoot('mcp-oauth-store-') })
    const serverUrl = new URL(remote.mcpUrl)
    const callback = createServer()
    const baseUrl = new URL(await listen(callback))
    cleanup.push(() => closeServer(callback))
    const handler = createOAuthHttpHandler({
      secret: randomBytes(32).toString('hex'),
      baseUrl,
      login: {
        get: async (serverId) => summarizeMcpOAuth(await store.read(serverId)),
        complete: (params) =>
          completeMcpOAuthLogin({
            ...params,
            serverUrl,
            staticClient: { clientId: CLIENT_ID },
            store,
            fetchImpl: fetch,
          }),
      },
      resolveServer: async (serverId) =>
        serverId === SERVER_ID ? { serverUrl, staticClientId: CLIENT_ID } : undefined,
    })
    callback.on('request', (req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
    })

    // The browser: start, the authorization server's consent redirect, then the callback.
    const started = await handler.startAuthorization(SERVER_ID)
    if (!('authorizeUrl' in started)) throw new Error(`sign-in did not start: ${JSON.stringify(started)}`)
    const consent = await fetch(started.authorizeUrl, { redirect: 'manual' })
    const back = await fetch(consent.headers.get('location') ?? '', { redirect: 'manual' })
    expect(back.status).toBe(200)
    expect(await store.read(SERVER_ID)).toMatchObject({ version: 2, rev: 1, tokens: { accessToken: 'at-1' } })

    const { host, applied, call } = await sessionRows(store, remote)
    expect(applied.statuses.get(SERVER_ID)).toMatchObject({ connectionState: 'ready', toolCount: 1 })
    expect(tool(host)).toBeDefined()
    const result = await call()
    expect(result.isError).toBeUndefined()
    expect(lastText(result)).toContain('echoed')
    const sent = remote.mcpEvents()
    expect(sent.some((event) => event.kind === 'mcp' && event.method === 'POST')).toBe(true)
    expect(sent.every((event) => event.kind === 'mcp' && event.authorization === 'Bearer at-1')).toBe(true)
  })

  it('expired token is refreshed before connect', async () => {
    const remote = await startRemote()
    const store = createMcpOAuthStore({ root: await tempRoot('mcp-oauth-store-') })
    await seedSignIn(store, remote, { access: 'at-0', expiresAt: Date.now() - 1 })
    const { applied } = await sessionRows(store, remote)
    expect(applied.statuses.get(SERVER_ID)).toMatchObject({ connectionState: 'ready' })
    expect(remote.refreshGrants()).toHaveLength(1)
    expect(remote.refreshGrants()[0]).toMatchObject({ form: { refresh_token: 'rt-0', client_id: CLIENT_ID } })
    // The refresh came before the first request to the MCP server, which never saw the old token.
    expect(remote.events[0]).toMatchObject({ kind: 'token', grant: 'refresh_token' })
    expect(
      remote.mcpEvents().every((event) => event.kind === 'mcp' && event.authorization === 'Bearer at-1'),
    ).toBe(true)
    expect(await store.read(SERVER_ID)).toMatchObject({
      rev: 2,
      tokens: { accessToken: 'at-1', refreshToken: 'rt-1' },
    })
  })

  it('401 mid-call: refresh and one retry succeed', async () => {
    const remote = await startRemote()
    const store = createMcpOAuthStore({ root: await tempRoot('mcp-oauth-store-') })
    await seedSignIn(store, remote, { access: 'at-0', expiresAt: Date.now() + 3_600_000 })
    const { applied, call } = await sessionRows(store, remote)
    expect(applied.statuses.get(SERVER_ID)).toMatchObject({ connectionState: 'ready' })
    const before = remote.mcpEvents().length
    remote.revoke('at-0')

    const result = await call()

    expect(result.isError).toBeUndefined()
    expect(lastText(result)).toContain('echoed')
    expect(remote.refreshGrants()).toHaveLength(1)
    expect(remote.mcpEvents().slice(before)).toEqual([
      { kind: 'mcp', method: 'POST', authorization: 'Bearer at-0', status: 401 },
      { kind: 'mcp', method: 'POST', authorization: 'Bearer at-1', status: 200 },
    ])
  })

  it('a server refusing every token: a mutating call is refused with the sign-in text, one refresh per attempt', async () => {
    const remote = await startRemote()
    const store = createMcpOAuthStore({ root: await tempRoot('mcp-oauth-store-') })
    await seedSignIn(store, remote, { access: 'at-0', expiresAt: Date.now() + 3_600_000 })
    const { host, runtime, applied, call } = await sessionRows(store, remote)
    expect(applied.statuses.get(SERVER_ID)).toMatchObject({ connectionState: 'ready' })
    // `echo` carries no hints, so it counts as a tool that changes things.
    expect(tool(host)?.meta).toMatchObject({ isReadOnly: false, replay: 'never' })
    const before = remote.events.length
    remote.refuseEveryToken()

    // Returned, not thrown: the server refused, so the call is known not to have run.
    const result = await call()

    expect(result.isError).toBe(true)
    expect(lastText(result)).toContain(`MCP server "${SERVER_ID}" needs sign-in`)
    const during = remote.events.slice(before)
    expect(during).toEqual([
      { kind: 'mcp', method: 'POST', authorization: 'Bearer at-0', status: 401 },
      expect.objectContaining({ kind: 'token', grant: 'refresh_token' }),
      { kind: 'mcp', method: 'POST', authorization: 'Bearer at-1', status: 401 },
    ])
    await vi.waitFor(
      () =>
        expect(runtime.status(SERVER_ID)).toMatchObject({
          connectionState: 'unavailable',
          lastSafeError: { code: 'MCP_OAUTH_NEEDS_RECONNECT' },
        }),
      { timeout: 5_000 },
    )
    // Every attempt (the call, then each reconnect) is a refused send, one refresh, one refused
    // resend: between two refreshes there are exactly two sends, never a third.
    const later = remote.events.slice(before)
    expect(later.every((event) => event.kind === 'token' || event.status === 401)).toBe(true)
    const sendsBetweenRefreshes = later
      .map((event) => (event.kind === 'token' ? '|' : 's'))
      .join('')
      .split('|')
    expect(sendsBetweenRefreshes[0]).toBe('s')
    for (const run of sendsBetweenRefreshes.slice(1, -1)) expect(run).toBe('ss')
    expect(['', 's', 'ss']).toContain(sendsBetweenRefreshes.at(-1))
    expect(remote.refreshGrants().length).toBeGreaterThanOrEqual(2)
  })

  it('two stores on one root refresh at once: one refresh grant', async () => {
    const remote = await startRemote()
    const root = await tempRoot('mcp-oauth-store-')
    await seedSignIn(createMcpOAuthStore({ root }), remote, { access: 'at-0', expiresAt: Date.now() - 1 })
    // Two processes: each has its own store on the same files and its own authorizer.
    const authorizers = [createMcpOAuthStore({ root }), createMcpOAuthStore({ root })].map((store) =>
      createMcpOAuthAuthorizer({
        serverId: SERVER_ID,
        serverUrl: new URL(remote.mcpUrl),
        store,
        fetchImpl: fetch,
      }),
    )
    const headers = await Promise.all(authorizers.map((authorizer) => authorizer.headers()))
    expect(headers).toEqual([{ authorization: 'Bearer at-1' }, { authorization: 'Bearer at-1' }])
    expect(remote.refreshGrants()).toHaveLength(1)
  })

  it('after logout and signOut the server sees no further request with the old token, and the row is unavailable', async () => {
    const remote = await startRemote()
    const store = createMcpOAuthStore({ root: await tempRoot('mcp-oauth-store-') })
    await seedSignIn(store, remote, { access: 'at-0', expiresAt: Date.now() + 3_600_000 })
    const { host, runtime, entry, applied, call } = await sessionRows(store, remote)
    expect(applied.statuses.get(SERVER_ID)).toMatchObject({ connectionState: 'ready' })
    const before = remote.mcpEvents().length
    const eventsBefore = remote.events.length

    // Logout: the signed-out record, epoch + 1. The live row refuses before anything is sent.
    expect(await signOutMcpOAuth({ serverId: SERVER_ID, store })).toEqual({ epoch: 1 })
    const result = await call()

    expect(result.isError).toBe(true)
    expect(lastText(result)).toContain(`MCP server "${SERVER_ID}" needs sign-in`)
    await vi.waitFor(
      () =>
        expect(runtime.status(SERVER_ID)).toMatchObject({
          connectionState: 'unavailable',
          lastSafeError: { code: 'MCP_OAUTH_NEEDS_RECONNECT' },
        }),
      { timeout: 5_000 },
    )
    expect(remote.mcpEvents().slice(before)).toEqual([])

    // The sign-out then drops the row: no candidate connection, the tool is gone, the row is
    // unavailable and needs sign-in, and nothing reaches the server afterwards.
    runtime.signOut(SERVER_ID)
    const dropped = await runtime.apply([entry])
    expect(dropped.statuses.get(SERVER_ID)).toMatchObject({
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_OAUTH_NEEDS_RECONNECT' },
    })
    expect(tool(host)).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(remote.events.slice(eventsBefore)).toEqual([])
  })
})
