import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { createSearchAdmin } from '@agnes/base/search'
import { createCredentialStore } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { InferenceEvent, ToolCall } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createAdminSurface } from '../src/packages/admin-surface.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const tlsCert = readFileSync(new URL('../../../tools/test-fixtures/tls/localhost-cert.pem', import.meta.url))
const tlsKey = readFileSync(new URL('../../../tools/test-fixtures/tls/localhost-key.pem', import.meta.url))
const dirs: string[] = []
const closers: Array<() => Promise<void>> = []
let restoreFetch: (() => void) | undefined

afterEach(async () => {
  restoreFetch?.()
  restoreFetch = undefined
  await Promise.all(closers.splice(0).map((close) => close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler)
  return new Promise<{ origin: string }>((resolve, reject) => {
    http.listen(0, '127.0.0.1', () => {
      const address = http.address()
      if (!address || typeof address === 'string') {
        reject(new Error('listener missing'))
        return
      }
      closers.push(
        () =>
          new Promise((done) => {
            http.closeAllConnections()
            http.close(() => done())
          }),
      )
      resolve({ origin: `http://127.0.0.1:${address.port}` })
    })
  })
}

function listenTls(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const https = createHttpsServer({ key: tlsKey, cert: tlsCert }, handler)
  return new Promise<{ origin: string }>((resolve, reject) => {
    https.listen(0, '127.0.0.1', () => {
      const address = https.address()
      if (!address || typeof address === 'string') {
        reject(new Error('listener missing'))
        return
      }
      closers.push(
        () =>
          new Promise((done) => {
            https.closeAllConnections()
            https.close(() => done())
          }),
      )
      resolve({ origin: `https://127.0.0.1:${address.port}` })
    })
  })
}

function installFixtureFetch(origin: string): void {
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith(origin)) return original(input, init)
    const headers = new Headers(init?.headers)
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: init?.method ?? 'GET',
          headers: Object.fromEntries(headers.entries()),
          ca: tlsCert,
          servername: 'localhost',
          checkServerIdentity: () => undefined,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 }))
          })
        },
      )
      req.on('error', reject)
      req.end()
    })
  }
  restoreFetch = () => {
    globalThis.fetch = original
  }
}

function toolText(value: unknown): string {
  const messages = (value as { messages?: { role?: string; content?: { type?: string; text?: string }[] }[] })
    .messages
  return (messages ?? [])
    .filter((message) => message.role === 'tool_result')
    .flatMap((message) => message.content ?? [])
    .map((block) => block.text ?? '')
    .join('\n')
}

describe('search configured through the admin surface', () => {
  it('returns cited results from a new host session', async () => {
    const seen: string[] = []
    const fixture = await listen((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      seen.push(`${url.pathname}${url.search}`)
      response.writeHead(url.pathname === '/search' ? 200 : 404, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          results: [{ title: 'Agnes notes', url: 'https://example.com/agnes', content: 'A public note.' }],
        }),
      )
    })
    const home = mkdtempSync(join(tmpdir(), 'agh-search-session-'))
    dirs.push(home)
    const dataDir = join(home, 'data')
    mkdirSync(dataDir, { recursive: true })
    // The launcher writes credentials at the scope home and configuration under scope dataDir.
    const credentials = createCredentialStore({ root: home })
    const searchAdmin = createSearchAdmin({
      dataDir,
      credentials: {
        async read(ref) {
          const stored = await credentials.read(ref)
          return stored?.kind === 'api-key' ? stored.value : undefined
        },
        write(ref, value) {
          return credentials.putApiKey(ref, value)
        },
        remove(ref) {
          return credentials.remove(ref)
        },
      },
    })
    let handler: ReturnType<typeof createAdminSurface> | undefined
    const admin = await listen(async (request, response) => {
      if (!(await handler?.handle(request, response))) response.writeHead(404).end()
    })
    handler = createAdminSurface({
      searchAdmin,
      origin: admin.origin,
      token: 'search-session-token',
      profile: 'local-dev',
      clientId: 'admin-web',
      invoke: async () => ({ packages: [] }),
    })
    const headers = { Origin: admin.origin, 'Content-Type': 'application/json' }
    const context = await fetch(`${admin.origin}/admin/plugins/api/context`, { headers })
    expect(await context.json()).toMatchObject({ readOnly: false })
    const saved = await fetch(`${admin.origin}/admin/api/search`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        defaultProvider: 'searxng',
        provider: {
          id: 'searxng',
          enabled: true,
          endpoint: fixture.origin,
          maxResults: 3,
          timeoutMs: 15000,
          ratePerMinute: 2,
        },
      }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ configured: true, defaultProvider: 'searxng' })
    const tested = await fetch(`${admin.origin}/admin/api/search/test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'searxng', query: 'agnes harness' }),
    })
    expect(await tested.json()).toMatchObject({
      ok: true,
      provider: 'searxng',
      results: [
        expect.objectContaining({
          query: 'agnes harness',
          title: 'Agnes notes',
          url: 'https://example.com/agnes',
          snippet: expect.stringContaining('Citations:\n- https://example.com/agnes'),
        }),
      ],
    })
    expect(seen.some((url) => url.includes('/search?') && url.includes('format=json'))).toBe(true)

    const callTool = (name: string, args: ToolCall['args']): InferenceEvent[] => [
      { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
      { type: 'done', reason: 'toolUse' },
    ]
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        callTool('web_search', { queries: ['agnes harness'] }),
        [
          { type: 'text_delta', delta: 'Found it.' },
          { type: 'done', reason: 'stop' },
        ],
      ],
      onExhausted: 'error',
    })
    const { host } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
    })
    closers.push(() => host.close())
    const session = await host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Search for Agnes' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    const turn = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(turn).toMatchObject({ reason: 'completed' })
    const cited = toolText(provider.calls[1])
    expect(cited).toContain('[agnes harness] Agnes notes')
    expect(cited).toContain('https://example.com/agnes')
    expect(cited).toContain('A public note.')
    expect(cited).toContain('Citations:\n- https://example.com/agnes')
    const limited = await fetch(`${admin.origin}/admin/api/search/test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'searxng', query: 'again' }),
    })
    expect(await limited.json()).toMatchObject({ ok: false, code: 'SEARCH_RATE_LIMITED' })
  }, 60_000)

  it('uses a keyed provider saved on a fresh profile', async () => {
    const key = 'brave-fixture-key-0607'
    const seen: string[] = []
    const fixture = await listenTls((request, response) => {
      const url = new URL(request.url ?? '/', 'https://127.0.0.1')
      seen.push(`${request.headers['x-subscription-token'] ?? ''} ${url.pathname}`)
      const authorized = request.headers['x-subscription-token'] === key
      response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          web: {
            results: [
              { title: 'Agnes notes', url: 'https://example.com/agnes', description: 'A public note.' },
            ],
          },
        }),
      )
    })
    installFixtureFetch(fixture.origin)
    const home = mkdtempSync(join(tmpdir(), 'agh-search-keyed-'))
    dirs.push(home)
    const dataDir = join(home, 'data')
    mkdirSync(dataDir, { recursive: true })
    const credentials = createCredentialStore({ root: home })
    const searchAdmin = createSearchAdmin({
      dataDir,
      credentials: {
        async read(ref) {
          const stored = await credentials.read(ref)
          return stored?.kind === 'api-key' ? stored.value : undefined
        },
        write(ref, value) {
          return credentials.putApiKey(ref, value)
        },
        remove(ref) {
          return credentials.remove(ref)
        },
      },
    })
    let handler: ReturnType<typeof createAdminSurface> | undefined
    const admin = await listen(async (request, response) => {
      if (!(await handler?.handle(request, response))) response.writeHead(404).end()
    })
    handler = createAdminSurface({
      searchAdmin,
      origin: admin.origin,
      token: 'search-session-token',
      profile: 'local-dev',
      clientId: 'admin-web',
      invoke: async () => ({ packages: [] }),
    })
    const headers = { Origin: admin.origin, 'Content-Type': 'application/json' }
    expect(
      await (await fetch(`${admin.origin}/admin/plugins/api/context`, { headers })).json(),
    ).toMatchObject({
      readOnly: false,
    })
    const saved = await fetch(`${admin.origin}/admin/api/search`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        defaultProvider: 'brave',
        apiKey: key,
        provider: {
          id: 'brave',
          enabled: true,
          endpoint: fixture.origin,
          maxResults: 3,
          timeoutMs: 15000,
          ratePerMinute: 10,
        },
      }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ configured: true, defaultProvider: 'brave' })
    expect(existsSync(join(home, 'secrets', 'search', 'brave'))).toBe(true)
    expect(existsSync(join(dataDir, 'secrets', 'search', 'brave'))).toBe(false)

    const callTool = (name: string, args: ToolCall['args']): InferenceEvent[] => [
      { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
      { type: 'done', reason: 'toolUse' },
    ]
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        callTool('web_search', { queries: ['agnes harness'] }),
        [
          { type: 'text_delta', delta: 'Found it.' },
          { type: 'done', reason: 'stop' },
        ],
      ],
      onExhausted: 'error',
    })
    const { host, profile } = await createTestHost({
      dataDir,
      packageDirs: { '@agnes/base': baseDir },
      provider,
      disableSessionTitle: true,
    })
    expect(profile.adapters.secrets).toEqual({ kind: 'file' })
    closers.push(() => host.close())
    const session = await host.createSession({ cwd: dataDir })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'Search for Agnes' }],
      actor: session.d.actor,
      kind: 'prompt',
    })
    const turn = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(turn).toMatchObject({ reason: 'completed' })
    const cited = toolText(provider.calls[1])
    expect(cited).toContain('[agnes harness] Agnes notes')
    expect(cited).toContain('https://example.com/agnes')
    expect(cited).toContain('A public note.')
    expect(cited).toContain('Citations:\n- https://example.com/agnes')
    expect(cited).not.toContain(key)
    expect(seen).toContain(`${key} /res/v1/web/search`)
  }, 60_000)
})
