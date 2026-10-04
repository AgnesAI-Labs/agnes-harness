import { createHash } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { jcs } from '@agnes/protocol'
import {
  type ClientArtifactOpenStreamRequest,
  type ClientArtifactReadRangeRequest,
  type ClientCallHeader,
  type ClientCatalogPageRequest,
  type ClientCloseSubscriptionRequest,
  type ClientCommandRequest,
  type ClientJsonOperation,
  type ClientQueryRequest,
  type ClientReadSubscriptionRequest,
  type ClientSubscribeRequest,
  type ClientSubscriptionFrame,
  encodeClientBinaryMetadata,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  type RuntimeError,
  runtimeErrorHttpStatus,
  validateClientBinaryRequest,
  validateClientBootstrap,
  validateClientCatalogPage,
  validateClientCommandRequest,
  validateClientQueryRequest,
  validateClientReply,
  validateClientTransportReplyFrame,
  validateClientTransportRequestFrame,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  artifactReader,
  type LocalRefusal,
  RUNTIME_JOURNAL_KEY,
  type RuntimeClientOptions,
  RuntimeClientTransport,
  type RuntimeSubscription,
  type RuntimeWebSocketFactory,
  subscriptions,
} from '@agnes/sdk/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { memoryJournal } from '../../src/journal.js'

const { routes, metadataHeader, binaryMime } = RuntimeClientTransportWire
const { maxReaderQueueFrames } = RuntimeClientTransportPolicy
const routeNames = new Map<string, string>(Object.entries(routes).map(([name, route]) => [route.path, name]))
const json = 'application/json; charset=utf-8'
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const capabilities = {
  clientInstanceId: 'ci-1',
  target: 'sdk' as const,
  protocols: [{ major: 2, minMinor: 0, maxMinor: 0 }],
  viewSchemaRanges: [],
  renderKeys: [],
  features: [RuntimeClientTransportWire.feature],
  capabilitiesRevision: 1,
  interaction: { text: true, singleChoice: true, multiChoice: true, confirm: true, complexFormLink: false },
  files: { link: true, upload: false, maxUploadBytes: 0, allowedMimes: [] },
  display: { plainText: true, markdown: true, maxTextBytes: 1024, inlinePreviewMimes: [] },
}
const hello = { capabilities, authorApi: [], loadedBundles: [] }
const schema = (n: number) => ({ typeId: `agh.test/item${n}@1`, revision: 1, digest: sha(Uint8Array.of(n)) })
const module = (moduleId: string, n: number) => ({
  moduleId,
  packageId: 'agh.test',
  packageDigest: sha(Uint8Array.of(0)),
  assetDigest: sha(Uint8Array.of(1)),
  entryPath: 'index.js',
  ownerToken: 'owner',
  authorApiMajor: 1,
  targets: ['sdk'],
  schemas: [schema(n)],
  requiredFeatures: [],
  styles: [],
})
type Page = { modules: ReturnType<typeof module>[]; domainSchemas: ReturnType<typeof schema>[] }
const page = (...entries: [string, number][]): Page => ({
  modules: entries.map(([id, n]) => module(id, n)),
  domainSchemas: entries.map(([, n]) => schema(n)),
})
const failure = (detailCode: string, code: RuntimeError['code'], advice: 'never' | 'retry_read' = 'never') =>
  ({
    code,
    detailCode,
    message: detailCode,
    retryAdvice: { kind: advice },
    diagnosticId: 'diag-1',
  }) as RuntimeError

const cancel = (requestId: string) => ({ sessionId: 'conv-1', runId: 'run-1', requestId })
const handle = (requestId: string, status: 'accepted' | 'not-accepted') =>
  status === 'accepted'
    ? {
        commandId: `cmd-${requestId}`,
        requestId,
        revision: 1,
        completion: 'runtime-accepted',
        status,
        result: null,
        error: null,
      }
    : { requestId, status, commandId: null, revision: null, completion: null, result: null, error: null }
const changed = (header: ClientCallHeader | null, catalogRevision: number) => ({
  kind: 'catalog-changed',
  header: { ...header, callId: 'push-1' },
  status: { catalogRevision, mode: 'compatible', reasonCode: null },
})
const catalogStatus = { catalogRevision: 1, mode: 'compatible', reasonCode: null }

const scope = { installationId: 'inst-1', runtimeId: 'rt-1', workspaceId: 'ws-1', kind: 'workspace' } as const
const snapshot = {
  page: { items: [], snapshot: 'snap-1', nextCursor: null, complete: true },
  nextCursor: null,
  complete: true,
}
const payloads = {
  snapshot,
  change: { kind: 'remove', interactionId: 'int-1', version: 1, reason: 'gone' },
  reset: { snapshot, reason: 'rebuilt' },
  end: { reason: 'done' },
  error: failure('backend_unavailable', 'retryable', 'retry_read'),
}
const frame = (kind: keyof typeof payloads, cursor: string, subscriptionId = 'sub-1') =>
  ({
    subscriptionId,
    topic: 'interactions',
    kind,
    cursor,
    payload: payloads[kind],
  }) as ClientSubscriptionFrame
/** A subscription frame as the server pushes it; the reader's call id is not one the client sent. */
const pushed = (header: ClientCallHeader | null, value: ClientSubscriptionFrame) => ({
  kind: 'subscription',
  header: { ...header, callId: 'push-1' },
  frame: value,
})

type Reply =
  | { value: unknown }
  | { error: RuntimeError }
  | { status: number; headers: Record<string, string>; body: string | Uint8Array }
  | 'drop'
  | 'manual'
const reply = (request: ClientQueryRequest | ClientCommandRequest, value: unknown): Reply => ({
  value: { header: request.header, reply: { operation: request.call.operation, value } },
})
const latch = () => {
  let open = (): void => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open: () => open() }
}
const binary = (kind: 'range' | 'stream', metadata: unknown, body: Uint8Array): Reply => {
  const header = encodeClientBinaryMetadata(kind, metadata)
  if (!header.ok) throw new Error('invalid test metadata')
  return { status: 200, headers: { 'content-type': binaryMime, [metadataHeader]: header.value }, body }
}

type Peer = Awaited<ReturnType<typeof peer>>
const servers = new Set<Server>()
const peers = new Set<Peer>()
afterEach(async () => {
  for (const p of peers) for (const socket of p.sockets) socket.terminate()
  for (const server of servers) server.closeAllConnections()
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))))
  servers.clear()
  const problems = [...peers].flatMap((peer) => peer.problems)
  peers.clear()
  expect(problems).toEqual([])
})

/** A loopback wire peer: it checks every request, socket frame and well-formed reply with the
 * protocol validators and records the raw requests and uplink frames it received. */
async function peer() {
  const state = {
    revision: 1,
    sessions: 0,
    catalogs: new Map<number, Page[]>([[1, [page(['m1', 1])]]]),
    adjust: (welcome: Record<string, unknown>) => welcome,
    subprotocol: true,
  }
  const handlers = {
    bootstrap: (): Reply | Promise<Reply> => {
      const negotiatedSession = `s${++state.sessions}`
      const pages = state.catalogs.get(state.revision) ?? []
      const welcome = {
        negotiatedSession,
        wireVersion: { major: 2, minor: 0 },
        catalogRevision: state.revision,
        capabilities: { ...capabilities, negotiatedSession, effectivePolicyRevision: 1 },
        ...pages[0],
        mode: 'compatible',
        reasons: [],
        clientInstanceId: 'ci-1',
      }
      const nextCursor = pages.length > 1 ? `${state.revision}:1` : null
      return { value: { welcome: state.adjust(welcome), catalogPage: { nextCursor, complete: !nextCursor } } }
    },
    catalogPage: (request: ClientCatalogPageRequest): Reply => {
      const [revision = 0, index = 0] = (request.cursor ?? '').split(':').map(Number)
      const pages = state.catalogs.get(revision)
      if (revision !== state.revision || !pages)
        return { error: failure('catalog_changed', 'conflict', 'retry_read') }
      const nextCursor = index + 1 < pages.length ? `${revision}:${index + 1}` : null
      return { value: { catalogRevision: revision, ...pages[index], nextCursor, complete: !nextCursor } }
    },
    clientQuery: (_request: ClientQueryRequest): Reply | Promise<Reply> => ({
      error: failure('operation_not_supported', 'incompatible'),
    }),
    clientCommand: (_request: ClientCommandRequest): Reply | Promise<Reply> => ({
      error: failure('operation_not_supported', 'incompatible'),
    }),
    readRange: (_request: ClientArtifactReadRangeRequest): Reply => ({
      error: failure('not_found', 'invalid_input'),
    }),
    openStream: (_request: ClientArtifactOpenStreamRequest, _response: ServerResponse): Reply => ({
      error: failure('not_found', 'invalid_input'),
    }),
    subscribe: (request: ClientSubscribeRequest): Reply | Promise<Reply> => ({
      value: {
        header: request.header,
        subscriptionId: 'sub-1',
        topic: request.topic,
        cursor: 'c0',
        frame: frame('snapshot', 'c0'),
      },
    }),
    readSubscription: (request: ClientReadSubscriptionRequest): Reply => ({
      value: { header: request.header, frames: [], nextCursor: null, hasMore: false },
    }),
    closeSubscription: (_request: ClientCloseSubscriptionRequest): Reply => ({ value: { closed: true } }),
  }
  const requests: { route: string; body: Record<string, unknown> }[] = []
  const problems: string[] = []
  const upgrades: { protocol: string | undefined; authorization: string | undefined }[] = []
  const sockets: WebSocket[] = []

  const answer = async (route: string, body: unknown, response: ServerResponse): Promise<Reply> => {
    const checked = (value: Reply, valid: (value: unknown) => boolean) => {
      if (typeof value === 'object' && 'value' in value && !valid(value.value))
        problems.push(`${route}: reply`)
      return value
    }
    const invalid = (): Reply => {
      problems.push(`${route}: request`)
      return { error: failure('invalid_request', 'invalid_input') }
    }
    if (route === 'bootstrap')
      return validateRuntime('ClientHello', body).ok
        ? checked(await handlers.bootstrap(), (value) => validateClientBootstrap(value).ok)
        : invalid()
    if (route === 'subscribe') {
      const request = validateRuntime('ClientSubscribeRequest', body)
      if (!request.ok) return invalid()
      return checked(
        await handlers.subscribe(request.value),
        (value) => validateRuntime('ClientSubscribeResult', value).ok,
      )
    }
    if (route === 'readSubscription') {
      const request = validateRuntime('ClientReadSubscriptionRequest', body)
      if (!request.ok) return invalid()
      return checked(
        handlers.readSubscription(request.value),
        (value) => validateRuntime('ClientReadSubscriptionResult', value).ok,
      )
    }
    if (route === 'closeSubscription') {
      const request = validateRuntime('ClientCloseSubscriptionRequest', body)
      if (!request.ok) return invalid()
      return checked(
        handlers.closeSubscription(request.value),
        (value) => validateRuntime('ClientCloseSubscriptionResult', value).ok,
      )
    }
    if (route === 'catalogPage') {
      const request = validateRuntime('ClientCatalogPageRequest', body)
      if (!request.ok) return invalid()
      return checked(
        handlers.catalogPage(request.value),
        (value) => validateClientCatalogPage(value, request.value.limit).ok,
      )
    }
    if (route === 'clientQuery' || route === 'clientCommand') {
      const request =
        route === 'clientQuery' ? validateClientQueryRequest(body) : validateClientCommandRequest(body)
      if (!request.ok) return invalid()
      const value =
        route === 'clientQuery'
          ? await handlers.clientQuery(request.value as ClientQueryRequest)
          : await handlers.clientCommand(request.value as ClientCommandRequest)
      return checked(value, (result) => validateClientReply(request.value, result).ok)
    }
    if (route === 'readRange') {
      const request = validateClientBinaryRequest('range', body)
      return request.ok ? handlers.readRange(request.value) : invalid()
    }
    const request = validateClientBinaryRequest('stream', body)
    return request.ok ? handlers.openStream(request.value, response) : invalid()
  }

  const server = createServer(async (req, res) => {
    const route = routeNames.get(req.url ?? '') ?? 'unknown'
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    requests.push({ route, body })
    if (req.method !== 'POST' || req.headers['content-type'] !== json) problems.push(`${route}: MIME`)
    const result =
      req.headers.authorization === 'Bearer token-1'
        ? await answer(route, body, res)
        : { error: failure('authentication_required', 'denied') }
    if (result === 'manual') return
    if (result === 'drop') return void req.socket.destroy()
    if ('status' in result) {
      res.writeHead(result.status, result.headers)
      return void res.end(result.body)
    }
    const outcome = 'value' in result ? { ok: true, value: result.value } : { ok: false, error: result.error }
    res.writeHead('error' in result ? runtimeErrorHttpStatus(result.error) : 200, { 'content-type': json })
    res.end(JSON.stringify(outcome))
  })
  servers.add(server)

  // The push socket answers uplinks with the same handlers as the HTTP routes.
  const { subprotocol } = routes.websocket
  const pushServer = new WebSocketServer({
    server,
    path: routes.websocket.path,
    handleProtocols: (offered) => (state.subprotocol && offered.has(subprotocol) ? subprotocol : false),
  })
  pushServer.on('connection', (socket, req) => {
    sockets.push(socket)
    upgrades.push({
      protocol: req.headers['sec-websocket-protocol'],
      authorization: req.headers.authorization,
    })
    socket.on('message', async (data, isBinary) => {
      const body = JSON.parse(String(data)) as Record<string, unknown>
      requests.push({ route: `ws:${String(body.kind)}`, body })
      const uplink = validateClientTransportRequestFrame(body)
      if (isBinary || !uplink.ok) return void problems.push('websocket: request')
      const { kind, request } = uplink.value
      const result =
        kind === 'query' ? await handlers.clientQuery(request) : await handlers.clientCommand(request)
      if (result === 'manual') return
      if (result === 'drop') return void socket.terminate()
      if ('status' in result) return void problems.push('websocket: HTTP-only reply')
      const value =
        'value' in result
          ? { kind: 'reply', result: result.value }
          : { kind: 'error', header: request.header, error: result.error }
      if (!validateClientTransportReplyFrame(request, value).ok) problems.push('websocket: reply')
      socket.send(JSON.stringify(value))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const created = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    handlers,
    requests,
    problems,
    upgrades,
    sockets,
    count: (route: string) => requests.filter((request) => request.route === route).length,
    /** A text frame on the newest socket; only well-formed transport frames are sent. */
    push: (value: unknown) => {
      if (!validateRuntime('ClientTransportFrame', value).ok) problems.push('websocket: push')
      sockets.at(-1)?.send(JSON.stringify(value))
    },
  }
  peers.add(created)
  return created
}

async function connected(
  p: Peer,
  credential: string | null = 'token-1',
  options: Partial<RuntimeClientOptions> = {},
) {
  const journal = memoryJournal('client-1')
  const client = new RuntimeClientTransport({
    baseUrl: p.url,
    hello,
    journal,
    ...(credential === null ? {} : { credential }),
    ...options,
  })
  await client.connect()
  return { client, journal }
}
const socket: RuntimeWebSocketFactory = (url, protocol, headers) => new WebSocket(url, protocol, { headers })
const withSocket = (p: Peer) => connected(p, 'token-1', { webSocket: socket })
/** The `ws` client, logging the kind of every frame the transport sends and receives. */
const tapped =
  (log: string[]): RuntimeWebSocketFactory =>
  (url, protocol, headers) => {
    const ws = new WebSocket(url, protocol, { headers })
    ws.addEventListener('message', (event) => log.push(`received ${JSON.parse(String(event.data)).kind}`))
    return {
      get protocol() {
        return ws.protocol
      },
      send: (data) => {
        log.push(`sent ${JSON.parse(data).kind}`)
        ws.send(data)
      },
      close: (code, reason) => ws.close(code, reason),
      addEventListener: (type, listener) => ws.addEventListener(type, listener),
    }
  }
async function subscribed(client: RuntimeClientTransport, pollIntervalMs = 5) {
  const result = await subscriptions(client, { pollIntervalMs }).subscribe({
    topic: 'interactions',
    input: { scope },
  })
  if (result.state !== 'ok') throw new Error(`not subscribed: ${result.state}`)
  return result.value
}
const drain = async (subscription: RuntimeSubscription) => {
  const seen: string[] = []
  for await (const item of subscription.frames) seen.push(`${item.kind} ${item.cursor}`)
  return seen
}
const pendingIds = async (journal: ReturnType<typeof memoryJournal>) =>
  (await journal.pending(RUNTIME_JOURNAL_KEY)).map((command) => command.commandId)

describe('bootstrap and the write gate', () => {
  it.each([
    {
      name: 'a refused bootstrap',
      arrange: (p: Peer) => {
        p.handlers.bootstrap = () => ({
          value: {
            mode: 'incompatible',
            reasonCode: 'wire_major',
            message: 'no common wire major',
            supportedProtocols: [{ major: 1, minMinor: 0, maxMinor: 0 }],
          },
        })
      },
      credential: 'token-1',
    },
    { name: 'an unauthenticated bootstrap', arrange: () => undefined, credential: null },
    {
      name: 'a welcome of another wire major',
      arrange: (p: Peer) => {
        p.state.adjust = (welcome) => ({ ...welcome, wireVersion: { major: 1, minor: 0 } })
      },
      credential: 'token-1',
    },
    {
      name: 'a welcome that is itself incompatible',
      arrange: (p: Peer) => {
        p.state.adjust = (welcome) => ({ ...welcome, mode: 'incompatible' })
      },
      credential: 'token-1',
    },
  ])('$name is incompatible, is not retried and sends no command', async ({ arrange, credential }) => {
    const p = await peer()
    arrange(p)
    const { client } = await connected(p, credential)
    expect(client.mode).toBe('incompatible')
    expect(client.refusal).not.toBeNull()
    expect(client.header()).toBeNull()
    expect(await client.command('conversation.cancel', cancel('req-1'))).toEqual({
      state: 'refused',
      reason: 'incompatible',
    })
    expect(p.requests.map((request) => request.route)).toEqual(['bootstrap'])
  })

  it.each<{ name: string; reason: LocalRefusal; arrange?: (p: Peer) => void; stale?: boolean }>([
    {
      name: 'an incomplete catalog',
      reason: 'catalog-incomplete',
      arrange: (p) => {
        p.state.catalogs.set(1, [page(['m1', 1]), page(['m2', 2])])
        p.handlers.catalogPage = () => ({ error: failure('permission_denied', 'denied') })
      },
    },
    {
      name: 'a reload-required welcome',
      reason: 'reload-required',
      arrange: (p) => {
        p.state.adjust = (welcome) => ({ ...welcome, mode: 'reload-required' })
      },
    },
    {
      name: 'a degraded welcome without the operation feature',
      reason: 'not-negotiated',
      arrange: (p) => {
        p.state.adjust = (welcome) => ({
          ...welcome,
          mode: 'degraded',
          capabilities: { ...(welcome.capabilities as object), features: [] },
        })
      },
    },
    { name: 'a session made stale by a catalog change', reason: 'disconnected', stale: true },
  ])('$name refuses commands locally', async ({ reason, arrange, stale }) => {
    const p = await peer()
    arrange?.(p)
    const { client, journal } = await connected(p)
    const again = stale ? client.handleFrame(changed(client.header(), 1)) : undefined
    expect(await client.command('conversation.cancel', cancel('req-1'))).toEqual({ state: 'refused', reason })
    await again
    expect(p.count('clientCommand')).toBe(0)
    expect(await pendingIds(journal)).toEqual([])
  })
})

describe('the catalog', () => {
  it('reads every page to completion and keeps one copy of each module and schema', async () => {
    const p = await peer()
    p.state.catalogs.set(1, [page(['m1', 1]), page(['m1', 1], ['m2', 2]), page(['m3', 3])])
    const { client } = await connected(p)
    expect(client.catalog).toEqual({
      complete: true,
      modules: [module('m1', 1), module('m2', 2), module('m3', 3)],
      domainSchemas: [schema(1), schema(2), schema(3)],
    })
    expect(
      p.requests.filter((r) => r.route === 'catalogPage').map((r) => [r.body.cursor, r.body.limit]),
    ).toEqual([
      ['1:1', RuntimeClientTransportPolicy.defaultCatalogPageLimit],
      ['1:2', RuntimeClientTransportPolicy.defaultCatalogPageLimit],
    ])
  })

  it('drops collected pages and bootstraps again after a catalog_changed refusal', async () => {
    const p = await peer()
    p.state.catalogs.set(1, [page(['m1', 1]), page(['m2', 2])])
    p.state.catalogs.set(2, [page(['m9', 9])])
    const welcome = p.handlers.bootstrap
    p.handlers.bootstrap = () => {
      const value = welcome()
      p.state.revision = 2
      return value
    }
    const { client, journal } = await connected(p)
    expect(p.count('bootstrap')).toBe(2)
    expect(client.catalog).toEqual({ complete: true, modules: [module('m9', 9)], domainSchemas: [schema(9)] })

    p.handlers.clientCommand = () => ({ error: failure('catalog_changed', 'conflict', 'retry_read') })
    expect(await client.command('conversation.cancel', cancel('req-1'))).toMatchObject({
      state: 'failed',
      error: { detailCode: 'catalog_changed' },
    })
    await client.connect()
    expect(p.count('bootstrap')).toBe(3)
    expect(client.catalog?.complete).toBe(true)
    expect(await pendingIds(journal)).toEqual([])
  })

  it('bootstraps again on a catalog-changed frame for the current session only', async () => {
    const p = await peer()
    p.state.catalogs.set(2, [page(['m2', 2])])
    const { client } = await connected(p)
    const first = client.header()
    p.state.revision = 2
    await client.handleFrame(changed(first, 2))
    expect(p.count('bootstrap')).toBe(2)
    expect(client.header()?.negotiatedSession).toBe('s2')
    expect(client.catalog?.modules).toEqual([module('m2', 2)])
    await client.handleFrame(changed(first, 3))
    expect(p.count('bootstrap')).toBe(2)
  })

  it('bootstraps again when a polled catalog status reports another revision', async () => {
    const p = await peer()
    const { client } = await connected(p)
    p.handlers.clientQuery = (request) =>
      reply(request, { catalogRevision: 2, mode: 'compatible', reasonCode: null })
    const header = client.header()
    if (!header) throw new Error('not connected')
    expect(await client.query('transport.catalogStatus', { header })).toMatchObject({ state: 'ok' })
    await client.connect()
    expect(p.count('bootstrap')).toBe(2)
  })
})

describe('replies', () => {
  it('drops a reply with another call header or from a replaced session without advancing state', async () => {
    const p = await peer()
    const { client, journal } = await connected(p)
    p.handlers.clientCommand = (request) => ({
      status: 200,
      headers: { 'content-type': json },
      body: JSON.stringify({
        ok: true,
        value: {
          header: { ...request.header, callId: 'another-call' },
          reply: { operation: request.call.operation, value: handle('req-1', 'accepted') },
        },
      }),
    })
    expect(await client.command('conversation.cancel', cancel('req-1'))).toMatchObject({ state: 'unknown' })

    const arrived = latch()
    const released = latch()
    p.handlers.clientCommand = async (request) => {
      arrived.open()
      await released.opened
      return reply(request, handle('req-2', 'accepted'))
    }
    const late = client.command('conversation.cancel', cancel('req-2'))
    await arrived.opened
    await client.handleFrame(changed(client.header(), 1))
    released.open()
    expect(await late).toMatchObject({ state: 'unknown' })
    expect(await pendingIds(journal)).toEqual(['req-1', 'req-2'])
    expect(client.header()?.negotiatedSession).toBe('s2')
    expect(client.mode).toBe('compatible')
  })
})

describe('the command journal', () => {
  it('journals an identity command before sending it and reports a lost reply as unknown', async () => {
    const p = await peer()
    const journal = memoryJournal('client-1')
    const events: string[] = []
    const client = new RuntimeClientTransport({
      baseUrl: p.url,
      hello,
      credential: 'token-1',
      journal: {
        ...journal,
        markPending: async (key, command) => {
          await journal.markPending(key, command)
          events.push(`journaled ${command.commandId}`)
        },
      },
      fetch: (url, init) => {
        events.push(`sent ${url.split('/').pop()}`)
        return fetch(url, init)
      },
    })
    await client.connect()
    let seen: unknown
    p.handlers.clientCommand = async () => {
      seen = await journal.pending(RUNTIME_JOURNAL_KEY)
      return 'drop' as const
    }
    expect(await client.command('conversation.cancel', cancel('req-1'))).toMatchObject({ state: 'unknown' })
    expect(events).toEqual(['sent bootstrap', 'journaled req-1', 'sent clientCommand'])
    const saved = [{ commandId: 'req-1', method: 'conversation.cancel', params: cancel('req-1') }]
    expect(seen).toEqual(saved)
    expect(await journal.pending(RUNTIME_JOURNAL_KEY)).toEqual(saved)

    // Only the user resends, with the original id and input; another input under that id never leaves.
    expect(await client.command('conversation.cancel', { ...cancel('req-1'), runId: 'run-2' })).toEqual({
      state: 'refused',
      reason: 'identity-conflict',
    })
    p.handlers.clientCommand = (request) => reply(request, handle('req-1', 'accepted'))
    expect(await client.command('conversation.cancel', cancel('req-1'))).toMatchObject({ state: 'ok' })
    expect(p.count('clientCommand')).toBe(2)
    expect(await journal.pending(RUNTIME_JOURNAL_KEY)).toEqual([])
  })

  const control = {
    sessionId: 'conv-1',
    requestId: 'req-1',
    expectedRevision: null,
    command: { kind: 'set-yolo', enabled: true },
  }
  it.each<{
    operation: ClientJsonOperation
    input: unknown
    status: ClientJsonOperation
    statusInput: unknown
    value: unknown
    state: 'accepted' | 'not-accepted'
  }>([
    {
      operation: 'conversation.cancel',
      input: cancel('req-1'),
      status: 'conversation.status',
      statusInput: 'req-1',
      value: handle('req-1', 'accepted'),
      state: 'accepted',
    },
    {
      operation: 'conversation.cancel',
      input: cancel('req-1'),
      status: 'conversation.status',
      statusInput: 'req-1',
      value: handle('req-1', 'not-accepted'),
      state: 'not-accepted',
    },
    {
      operation: 'control.submit',
      input: control,
      status: 'control.status',
      statusInput: { sessionId: 'conv-1', requestId: 'req-1' },
      value: {
        sessionId: 'conv-1',
        requestId: 'req-1',
        status: 'accepted',
        revision: 1,
        effective: null,
        runId: null,
        childSessionId: null,
        compact: null,
        error: null,
      },
      state: 'accepted',
    },
  ])('recover reports $state for $operation and never resends it', async (row) => {
    const p = await peer()
    const { client, journal } = await connected(p)
    p.handlers.clientCommand = () => 'drop'
    p.handlers.clientQuery = (request) => reply(request, row.value)
    expect(await client.command(row.operation, row.input as never)).toMatchObject({ state: 'unknown' })
    expect(await client.recover()).toEqual([{ id: 'req-1', operation: row.operation, state: row.state }])
    expect(await client.recover()).toEqual(
      row.state === 'accepted' ? [] : [{ id: 'req-1', operation: row.operation, state: row.state }],
    )
    const queries = p.requests.filter((r) => r.route === 'clientQuery').map((r) => r.body.call)
    expect(queries[0]).toEqual({ operation: row.status, input: row.statusInput })
    expect(p.count('clientCommand')).toBe(1)
    expect(await pendingIds(journal)).toEqual(row.state === 'accepted' ? [] : ['req-1'])
  })

  it.each<{ operation: ClientJsonOperation; input: unknown; journaled: string[] }>([
    {
      operation: 'permission.revokeGrant',
      input: {
        sessionId: 'conv-1',
        toolId: 'tool',
        scope: 'session',
        policyVersion: '1',
        grantId: 'grant-1',
        requestId: 'req-1',
      },
      journaled: ['req-1'],
    },
    {
      operation: 'interaction.formLink',
      input: { interactionId: 'int-1', expectedVersion: 1 },
      journaled: [],
    },
    {
      operation: 'artifact.openDownload',
      input: { artifactId: 'art-1', version: 1, disposition: 'attachment' },
      journaled: [],
    },
  ])('$operation only reports unknown after a lost reply', async ({ operation, input, journaled }) => {
    const p = await peer()
    const { client, journal } = await connected(p)
    p.handlers.clientCommand = () => 'drop'
    expect(await client.command(operation, input as never)).toMatchObject({ state: 'unknown' })
    expect(await client.recover()).toEqual(journaled.map((id) => ({ id, operation, state: 'unknown' })))
    expect(p.count('clientQuery')).toBe(0)
    expect(p.count('clientCommand')).toBe(1)
    expect(await pendingIds(journal)).toEqual(journaled)
  })
})

describe('the artifact reader', () => {
  const artifact = Uint8Array.from({ length: 10 }, (_, index) => index)
  const span = ([start, end]: readonly number[]) => artifact.subarray(start, end)

  it.each([
    { name: 'an exact range', offset: 0, bytes: 4, hashed: [0, 4], sent: [0, 4], verified: true },
    { name: 'a range clamped at EOF', offset: 8, bytes: 2, hashed: [8, 10], sent: [8, 10], verified: true },
    { name: 'a body shorter than its metadata', offset: 0, bytes: 4, hashed: [0, 4], sent: [0, 3] },
    { name: 'a body with another digest', offset: 0, bytes: 4, hashed: [1, 5], sent: [0, 4] },
    { name: 'a short read before EOF', offset: 8, bytes: 1, hashed: [8, 9], sent: [8, 9] },
  ] as const)('$name', async (row) => {
    const p = await peer()
    const { client } = await connected(p)
    const { offset, bytes } = row
    const digest = sha(span(row.hashed))
    p.handlers.readRange = () => binary('range', { offset, totalBytes: 10, bytes, digest }, span(row.sent))
    const result = await artifactReader(client).readRange({
      artifactId: 'art-1',
      version: 1,
      offset,
      length: 4,
    })
    if ('verified' in row)
      expect(result).toEqual({
        state: 'ok',
        value: { bytes: span(row.sent), offset, totalBytes: 10, digest },
      })
    else
      expect(result).toMatchObject({ state: 'failed', error: { code: 'internal', detailCode: 'integrity' } })
  })

  it.each([
    {
      name: 'a succeeded status with the received bytes and digest',
      status: { state: 'succeeded', bytes: 10, summary: { bytes: 10, digest: sha(artifact) }, error: null },
      ended: { state: 'ok', value: { bytes: 10, digest: sha(artifact) } },
    },
    {
      name: 'a succeeded status with another digest',
      status: {
        state: 'succeeded',
        bytes: 10,
        summary: { bytes: 10, digest: sha(span([0, 9])) },
        error: null,
      },
      ended: { state: 'failed', error: { detailCode: 'integrity' } },
    },
    {
      name: 'an unknown status',
      status: { state: 'unknown', bytes: null, summary: null, error: null },
      ended: { state: 'unknown' },
    },
  ])('a stream with $name', async ({ status, ended }) => {
    const p = await peer()
    const { client } = await connected(p)
    p.handlers.openStream = () =>
      binary('stream', { streamId: 'stream-1', offset: 0, totalBytes: 10 }, artifact)
    p.handlers.clientQuery = (request) => reply(request, { streamId: 'stream-1', ...status })
    const opened = await artifactReader(client).openStream({ artifactId: 'art-1', version: 1 })
    if (opened.state !== 'ok') throw new Error(`stream not opened: ${opened.state}`)
    const chunks: Uint8Array[] = []
    for await (const chunk of opened.value.chunks) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(artifact))
    expect(chunks.every((chunk) => chunk.length <= RuntimeClientTransportPolicy.maxRangeBytes)).toBe(true)
    expect(await opened.value.ended).toMatchObject(ended)
    const queries = p.requests.filter((r) => r.route === 'clientQuery').map((r) => r.body.call)
    expect(queries).toMatchObject([{ operation: 'transport.streamStatus', input: { streamId: 'stream-1' } }])
  })

  it('cancelling a stream aborts its request and never reports it verified', async () => {
    const p = await peer()
    const { client } = await connected(p)
    const closed = latch()
    p.handlers.openStream = (_request, response) => {
      const header = encodeClientBinaryMetadata('stream', { streamId: 'stream-1', offset: 0, totalBytes: 10 })
      response.on('close', closed.open)
      response.writeHead(200, { 'content-type': binaryMime, [metadataHeader]: header.ok ? header.value : '' })
      response.write(span([0, 5]))
      return 'manual'
    }
    const opened = await artifactReader(client).openStream({ artifactId: 'art-1', version: 1 })
    if (opened.state !== 'ok') throw new Error(`stream not opened: ${opened.state}`)
    for await (const chunk of opened.value.chunks) {
      expect(chunk).toEqual(span([0, 5]))
      await opened.value.cancel('enough')
    }
    expect(await opened.value.ended).toMatchObject({ state: 'failed', error: { detailCode: 'cancelled' } })
    await closed.opened
    expect(p.count('clientQuery')).toBe(0)
  })
})

describe('the push socket', () => {
  it.each([true, false])(
    'upgrades with the generated subprotocol and bearer (selected: %s)',
    async (selected) => {
      const p = await peer()
      p.state.subprotocol = selected
      p.handlers.clientQuery = (request) => reply(request, catalogStatus)
      const { client } = await withSocket(p)
      expect(p.upgrades).toEqual([
        { protocol: routes.websocket.subprotocol, authorization: 'Bearer token-1' },
      ])
      expect(client.pushOpen).toBe(selected)
      const header = client.header()
      if (!header) throw new Error('not connected')
      expect(await client.query('transport.catalogStatus', { header })).toEqual({
        state: 'ok',
        value: catalogStatus,
      })
      expect([p.count('ws:query'), p.count('clientQuery')]).toEqual(selected ? [1, 0] : [0, 1])
    },
  )

  it('carries queries and commands, journaling a command before its frame leaves', async () => {
    const p = await peer()
    const journal = memoryJournal('client-1')
    const log: string[] = []
    const client = new RuntimeClientTransport({
      baseUrl: p.url,
      hello,
      credential: 'token-1',
      webSocket: tapped(log),
      journal: {
        ...journal,
        markPending: async (key, command) => {
          await journal.markPending(key, command)
          log.push(`journaled ${command.commandId}`)
        },
      },
    })
    await client.connect()
    p.handlers.clientQuery = (request) => reply(request, handle('req-1', 'not-accepted'))
    p.handlers.clientCommand = (request) => reply(request, handle('req-1', 'accepted'))
    expect(await client.query('conversation.status', 'req-1')).toEqual({
      state: 'ok',
      value: handle('req-1', 'not-accepted'),
    })
    expect(await client.command('conversation.cancel', cancel('req-1'))).toEqual({
      state: 'ok',
      value: handle('req-1', 'accepted'),
    })
    expect(log).toEqual(['sent query', 'received reply', 'journaled req-1', 'sent command', 'received reply'])
    expect([
      p.count('ws:query'),
      p.count('ws:command'),
      p.count('clientQuery'),
      p.count('clientCommand'),
    ]).toEqual([1, 1, 0, 0])
    expect(await journal.pending(RUNTIME_JOURNAL_KEY)).toEqual([])
  })

  it('waits for its own reply and ignores another call id or a stale session', async () => {
    const p = await peer()
    const { client, journal } = await withSocket(p)
    p.handlers.clientCommand = (request) => {
      const answer = (header: ClientCallHeader, status: 'accepted' | 'not-accepted') => ({
        kind: 'reply',
        result: { header, reply: { operation: request.call.operation, value: handle('req-1', status) } },
      })
      p.push(answer({ ...request.header, callId: 'another-call' }, 'not-accepted'))
      p.push(answer({ ...request.header, negotiatedSession: 's0' }, 'not-accepted'))
      p.push({
        kind: 'error',
        header: { ...request.header, callId: 'another-call' },
        error: failure('not_found', 'invalid_input'),
      })
      p.push(answer(request.header, 'accepted'))
      return 'manual'
    }
    expect(await client.command('conversation.cancel', cancel('req-1'))).toEqual({
      state: 'ok',
      value: handle('req-1', 'accepted'),
    })
    expect(await pendingIds(journal)).toEqual([])
  })

  it.each([
    { name: 'a refused code clears the journal', error: failure('not_found', 'invalid_input'), pending: [] },
    {
      name: 'an effect-hiding code keeps the command pending',
      error: failure('backend_unavailable', 'retryable', 'retry_read'),
      pending: ['req-1'],
    },
    {
      name: 'catalog_changed bootstraps again',
      error: failure('catalog_changed', 'conflict', 'retry_read'),
      pending: [],
      bootstraps: 2,
    },
  ])('an error frame fails the call: $name', async ({ error, pending, bootstraps = 1 }) => {
    const p = await peer()
    const { client, journal } = await withSocket(p)
    p.handlers.clientCommand = () => ({ error })
    expect(await client.command('conversation.cancel', cancel('req-1'))).toEqual({ state: 'failed', error })
    expect(await pendingIds(journal)).toEqual(pending)
    await vi.waitFor(() => expect(client.pushOpen).toBe(true))
    expect([p.count('bootstrap'), p.upgrades.length]).toEqual([bootstraps, bootstraps])
  })

  it('leaves a command unknown when the socket drops and never resends it', async () => {
    const p = await peer()
    const { client, journal } = await withSocket(p)
    p.handlers.clientCommand = () => 'drop'
    expect(await client.command('conversation.cancel', cancel('req-1'))).toMatchObject({ state: 'unknown' })
    expect(client.pushOpen).toBe(false)
    expect(await pendingIds(journal)).toEqual(['req-1'])
    await client.connect()
    expect(client.pushOpen).toBe(true)
    p.handlers.clientQuery = (request) => reply(request, handle('req-1', 'accepted'))
    expect(await client.recover()).toEqual([
      { id: 'req-1', operation: 'conversation.cancel', state: 'accepted' },
    ])
    expect(p.requests.filter((r) => r.route.startsWith('ws:')).map((r) => r.body)).toMatchObject([
      { kind: 'command', request: { call: { operation: 'conversation.cancel', input: cancel('req-1') } } },
      { kind: 'query', request: { call: { operation: 'conversation.status', input: 'req-1' } } },
    ])
    expect([p.upgrades.length, p.count('clientCommand')]).toEqual([2, 0])
  })

  it('closes the socket on a binary frame and leaves the waiting call unknown', async () => {
    const p = await peer()
    const { client, journal } = await withSocket(p)
    p.handlers.clientCommand = (request) => {
      const value = {
        kind: 'reply',
        result: {
          header: request.header,
          reply: { operation: request.call.operation, value: handle('req-1', 'accepted') },
        },
      }
      p.sockets.at(-1)?.send(Buffer.from(JSON.stringify(value)))
      return 'manual'
    }
    expect(await client.command('conversation.cancel', cancel('req-1'))).toMatchObject({ state: 'unknown' })
    expect(client.pushOpen).toBe(false)
    expect(await pendingIds(journal)).toEqual(['req-1'])
    p.handlers.clientQuery = (request) => reply(request, catalogStatus)
    const header = client.header()
    if (!header) throw new Error('not connected')
    expect(await client.query('transport.catalogStatus', { header })).toMatchObject({ state: 'ok' })
    expect([p.count('ws:command'), p.count('clientQuery')]).toEqual([1, 1])
  })

  it('closes writes on a catalog-changed frame until the new catalog is read, and ends subscriptions', async () => {
    const p = await peer()
    p.state.catalogs.set(2, [page(['m2', 2])])
    const { client } = await withSocket(p)
    const subscription = await subscribed(client)
    const welcome = p.handlers.bootstrap
    const arrived = latch()
    const released = latch()
    p.handlers.bootstrap = async () => {
      arrived.open()
      await released.opened
      return welcome()
    }
    p.state.revision = 2
    p.push(changed(client.header(), 2))
    await arrived.opened
    expect([client.mode, client.catalog]).toEqual(['disconnected', null])
    expect(await client.command('conversation.cancel', cancel('req-1'))).toEqual({
      state: 'refused',
      reason: 'disconnected',
    })
    expect(await subscription.ended).toEqual({ reason: 'session-replaced' })
    released.open()
    await vi.waitFor(() => expect(client.pushOpen).toBe(true))
    expect(client.header()?.negotiatedSession).toBe('s2')
    expect(client.catalog?.modules).toEqual([module('m2', 2)])
    expect([p.upgrades.length, p.count('ws:command'), p.count('clientCommand')]).toEqual([2, 0, 0])
  })

  it('refuses an uplink over the JSON size bound before journaling or sending it', async () => {
    const p = await peer()
    const { client, journal } = await withSocket(p)
    const header = client.header()
    const call = (sessionId: string) => ({
      operation: 'conversation.cancel',
      input: { ...cancel('req-1'), sessionId },
    })
    const frameBytes = (sessionId: string) =>
      jcs({ kind: 'command', request: { header, call: call(sessionId) } }).length
    const sessionId = 'x'.repeat(RuntimeClientTransportPolicy.maxJsonBytes - frameBytes('') + 1)
    // Only the socket frame around the request is over the bound, by one byte.
    expect(frameBytes(sessionId)).toBe(RuntimeClientTransportPolicy.maxJsonBytes + 1)
    expect(jcs({ header, call: call(sessionId) }).length).toBeLessThan(
      RuntimeClientTransportPolicy.maxJsonBytes,
    )
    expect(await client.command('conversation.cancel', { ...cancel('req-1'), sessionId })).toEqual({
      state: 'refused',
      reason: 'invalid-request',
    })
    expect(p.requests.map((r) => r.route)).toEqual(['bootstrap'])
    expect(await pendingIds(journal)).toEqual([])
  })
})

describe('subscriptions', () => {
  it('delivers the initial frame, then only its own pushed frames in arrival order', async () => {
    const p = await peer()
    const { client } = await withSocket(p)
    const subscription = await subscribed(client)
    expect(subscription).toMatchObject({
      subscriptionId: 'sub-1',
      topic: 'interactions',
      first: frame('snapshot', 'c0'),
    })
    const header = client.header()
    p.push(pushed(header, frame('change', 'c1')))
    p.push(pushed(header, frame('change', 'x1', 'sub-2')))
    p.push(pushed(header, frame('change', 'c2')))
    p.push(pushed(header, frame('end', 'c3')))
    expect(await drain(subscription)).toEqual(['change c1', 'change c2', 'end c3'])
    expect(await subscription.ended).toEqual({ reason: 'end' })
    expect(p.requests.find((r) => r.route === 'subscribe')?.body).toMatchObject({
      topic: 'interactions',
      input: { scope },
    })
    expect([p.count('readSubscription'), p.count('closeSubscription')]).toEqual([0, 0])
  })

  it('keeps a frame pushed before the subscribe reply arrives', async () => {
    const p = await peer()
    const log: string[] = []
    const { client } = await connected(p, 'token-1', { webSocket: tapped(log) })
    const subscribe = p.handlers.subscribe
    p.handlers.subscribe = async (request) => {
      p.push(pushed(request.header, frame('change', 'c1')))
      await vi.waitFor(() => expect(log).toContain('received subscription'))
      return subscribe(request)
    }
    const subscription = await subscribed(client)
    p.push(pushed(client.header(), frame('end', 'c2')))
    expect(await drain(subscription)).toEqual(['change c1', 'end c2'])
  })

  it.each([
    { name: 'an end frame', kinds: ['reset', 'change', 'end'] as const, ended: { reason: 'end' } },
    {
      name: 'an error frame',
      kinds: ['change', 'error'] as const,
      ended: { reason: 'error', error: payloads.error },
    },
  ])(
    'delivers $name and then ends, while a reset is delivered and the stream goes on',
    async ({ kinds, ended }) => {
      const p = await peer()
      const { client } = await withSocket(p)
      const subscription = await subscribed(client)
      const header = client.header()
      for (const [n, kind] of [...kinds, 'change' as const].entries())
        p.push(pushed(header, frame(kind, `c${n + 1}`)))
      expect(await drain(subscription)).toEqual(kinds.map((kind, n) => `${kind} c${n + 1}`))
      expect(await subscription.ended).toEqual(ended)
    },
  )

  it('polls from the last cursor without a socket and asks for the catalog status when idle', async () => {
    const p = await peer()
    const { client } = await connected(p)
    p.handlers.clientQuery = (request) => reply(request, catalogStatus)
    const pages = [
      { frames: [frame('change', 'c1')], nextCursor: 'n1', hasMore: true },
      { frames: [frame('change', 'c2')], nextCursor: null, hasMore: false },
      { frames: [], nextCursor: null, hasMore: false },
      { frames: [frame('end', 'c3')], nextCursor: null, hasMore: false },
    ]
    const times: number[] = []
    p.handlers.readSubscription = (request) => {
      times.push(performance.now())
      return { value: { header: request.header, ...pages.shift() } }
    }
    const subscription = await subscribed(client, 100)
    expect(await drain(subscription)).toEqual(['change c1', 'change c2', 'end c3'])
    const reads = p.requests
      .filter((r) => r.route === 'readSubscription')
      .map((r) => [r.body.cursor, r.body.limit])
    expect(reads).toEqual(['c0', 'n1', 'c2', 'c2'].map((cursor) => [cursor, maxReaderQueueFrames]))
    // Only the empty page waited, and its idle cycle asked for the catalog status once.
    expect(p.requests.map((r) => r.route).slice(-3)).toEqual([
      'readSubscription',
      'clientQuery',
      'readSubscription',
    ])
    expect(p.requests.filter((r) => r.route === 'clientQuery').map((r) => r.body.call)).toMatchObject([
      { operation: 'transport.catalogStatus' },
    ])
    const [first = 0, , empty = 0, last = 0] = times
    expect(last - empty).toBeGreaterThanOrEqual(95)
    expect(empty - first).toBeLessThan(100)
  })

  it('polls from the last delivered cursor once the socket drops', async () => {
    const p = await peer()
    const { client } = await withSocket(p)
    const subscription = await subscribed(client)
    const header = client.header()
    p.push(pushed(header, frame('change', 'c1')))
    p.push(pushed(header, frame('change', 'c2')))
    const frames = subscription.frames[Symbol.asyncIterator]()
    expect((await frames.next()).value).toEqual(frame('change', 'c1'))
    p.handlers.readSubscription = (request) => ({
      value: { header: request.header, frames: [frame('end', 'c3')], nextCursor: null, hasMore: false },
    })
    p.sockets.at(-1)?.terminate()
    await vi.waitFor(() => expect(client.pushOpen).toBe(false))
    expect((await frames.next()).value).toEqual(frame('change', 'c2'))
    expect((await frames.next()).value).toEqual(frame('end', 'c3'))
    expect(p.requests.filter((r) => r.route === 'readSubscription').map((r) => r.body.cursor)).toEqual(['c2'])
  })

  it.each([
    { held: maxReaderQueueFrames, ended: { reason: 'end' }, closes: 0 },
    { held: maxReaderQueueFrames + 1, ended: { reason: 'overflow' }, closes: 1 },
  ])('ends with $ended.reason when $held frames wait undelivered', async ({ held, ended, closes }) => {
    const p = await peer()
    const { client } = await withSocket(p)
    const subscription = await subscribed(client)
    const header = client.header()
    for (let n = 1; n < held; n++) p.push(pushed(header, frame('change', `c${n}`)))
    p.push(pushed(header, frame('end', `c${held}`)))
    // The reply follows the pushed frames on the same socket, so every one of them has arrived.
    p.handlers.clientQuery = (request) => reply(request, catalogStatus)
    if (!header) throw new Error('not connected')
    expect(await client.query('transport.catalogStatus', { header })).toMatchObject({ state: 'ok' })
    expect(await drain(subscription)).toHaveLength(closes ? 0 : held)
    expect(await subscription.ended).toEqual(ended)
    await vi.waitFor(() => expect(p.count('closeSubscription')).toBe(closes))
  })

  it.each([
    {
      name: 'resync_required',
      answer: { error: failure('resync_required', 'conflict', 'retry_read') },
      ended: { reason: 'resync-required' },
    },
    {
      name: 'another typed failure',
      answer: { error: failure('not_found', 'invalid_input') },
      ended: { reason: 'error', error: failure('not_found', 'invalid_input') },
    },
    {
      name: 'catalog_changed',
      answer: { error: failure('catalog_changed', 'conflict', 'retry_read') },
      ended: { reason: 'session-replaced' },
      bootstraps: 2,
    },
    { name: 'no reply', answer: 'drop' as const, ended: { reason: 'unknown' } },
  ])('a poll answered by $name ends the subscription', async ({ answer, ended, bootstraps = 1 }) => {
    const p = await peer()
    const { client } = await connected(p)
    p.handlers.readSubscription = () => answer
    const subscription = await subscribed(client)
    expect(await drain(subscription)).toEqual([])
    expect(await subscription.ended).toEqual(ended)
    await vi.waitFor(() => expect(p.count('bootstrap')).toBe(bootstraps))
    expect(p.count('closeSubscription')).toBe(0)
  })

  it('close ends at once and sends closeSubscription once', async () => {
    const p = await peer()
    const { client } = await connected(p)
    const subscription = await subscribed(client)
    const first = subscription.close()
    expect(subscription.close()).toBe(first)
    expect(await subscription.ended).toEqual({ reason: 'closed' })
    expect(await first).toEqual({ state: 'ok', value: { closed: true } })
    expect(await drain(subscription)).toEqual([])
    expect(p.requests.filter((r) => r.route === 'closeSubscription').map((r) => r.body)).toMatchObject([
      { subscriptionId: 'sub-1' },
    ])
  })
})
