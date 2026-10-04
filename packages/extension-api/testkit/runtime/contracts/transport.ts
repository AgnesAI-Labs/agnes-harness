import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Outcome } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  RuntimeErrorDetails,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, type ReuseLifecycle, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { AssertionInput, ConformanceHarness } from '../harness.js'

const CONTRACT = 'agh.transport'
const HEX = /^[a-f0-9]{64}$/
const { routes, jsonMime, wireMajor: WIRE_MAJOR } = RuntimeClientTransportWire
const LIMIT = RuntimeClientTransportPolicy.maxJsonBytes
const JSON_TYPE = `${jsonMime}; charset=utf-8`
/** The JSON routes of the generated table; the binary artifact routes and the push socket are not judged here. */
const JSON_ROUTES = [
  'bootstrap',
  'clientQuery',
  'clientCommand',
  'catalogPage',
  'subscribe',
  'readSubscription',
  'closeSubscription',
  'catalogStatus',
  'streamStatus',
] as const

/**
 * The owner a transport hands validated requests to. The cases supply one, recording what reaches it,
 * so every implementation is judged on what it lets through and how it answers.
 */
export interface TransportBacking {
  bootstrap(hello: Wire.ClientHello): Promise<Outcome<Wire.ClientBootstrapResult>>
  catalogPage(request: Wire.ClientCatalogPageRequest): Promise<Outcome<Wire.ClientCatalogPageResult>>
  /** The JSON operations this owner serves; the transport refuses any other as not supported. */
  readonly operations: readonly Wire.ClientJsonOperation[]
  call(
    operation: Wire.ClientJsonOperation,
    input: unknown,
    header: Wire.ClientCallHeader,
  ): Promise<Outcome<unknown>>
  subscribe(request: Wire.ClientSubscribeRequest): Promise<Outcome<Wire.ClientSubscribeResult>>
  readSubscription(
    request: Wire.ClientReadSubscriptionRequest,
  ): Promise<Outcome<Wire.ClientReadSubscriptionResult>>
  closeSubscription(
    request: Wire.ClientCloseSubscriptionRequest,
  ): Promise<Outcome<Wire.ClientCloseSubscriptionResult>>
}

/** Who a listener admits: a bearer credential, or the exact page origin naming the listener's own Host. */
export type TransportAdmission =
  | { readonly kind: 'bearer'; readonly credential: string }
  | { readonly kind: 'page-origin'; readonly origin: string }

export interface TransportServer {
  /** The deployment origin plus mount prefix the generated route paths hang under. */
  readonly baseUrl: string
  /** The certificate authority a TLS listener's certificate chains to. */
  readonly ca?: string
  /** Stops accepting, cuts open connections and releases the port; later calls share the first. */
  close(): Promise<void>
}

export type TransportCallResult<T> =
  | { readonly state: 'ok'; readonly value: T }
  | { readonly state: 'failed'; readonly error: Wire.RuntimeError }
  | { readonly state: 'refused' | 'unknown'; readonly reason: string }
export type TransportSubscribeRequest = Wire.ClientSubscribeRequest extends infer R
  ? R extends unknown
    ? Omit<R, 'header'>
    : never
  : never
export interface TransportSubscription {
  readonly subscriptionId: string
  readonly first: Wire.ClientSubscriptionFrame
  readonly frames: AsyncIterable<Wire.ClientSubscriptionFrame>
  readonly ended: Promise<{ readonly reason: string }>
  close(): Promise<TransportCallResult<unknown>>
}
export type TransportFetch = (url: string, init: RequestInit) => Promise<Response>

export interface TransportClientOptions {
  readonly baseUrl: string
  readonly hello: Wire.ClientHello
  /** Sent as `Authorization: Bearer` when the listener admits a bearer credential. */
  readonly credential?: string
  /** Every request leaves through this fetch: the cases' network, with the faults they inject. */
  readonly fetch: TransportFetch
  /** A durable journal by name; clients made with the same name share pending commands, as a reloaded page does. */
  readonly journal: string
  readonly pollIntervalMs: number
}

/** The runtime client the cases speak through; both providers are driven by the same one. */
export interface TransportClient {
  readonly mode: string
  /** Subscription listeners the client still holds. */
  readonly listeners: { readonly size: number }
  connect(): Promise<void>
  query<K extends Wire.ClientJsonOperation>(
    operation: K,
    input: Wire.ClientOperationTypes[K]['input'],
    signal?: AbortSignal,
  ): Promise<TransportCallResult<Wire.ClientOperationTypes[K]['output']>>
  command<K extends Wire.ClientJsonOperation>(
    operation: K,
    input: Wire.ClientOperationTypes[K]['input'],
    signal?: AbortSignal,
  ): Promise<TransportCallResult<Wire.ClientOperationTypes[K]['output']>>
  /** Asks the owner of each pending command for its status by the original id; resends nothing. */
  recover(): Promise<readonly { readonly id: string; readonly operation: string; readonly state: string }[]>
  /** The ids of the journal's pending commands. */
  pending(): Promise<readonly string[]>
  subscribe(
    request: TransportSubscribeRequest,
    signal?: AbortSignal,
  ): Promise<TransportCallResult<TransportSubscription>>
}

/**
 * A binding supplies the server under test and the runtime client the cases drive it through. Each
 * scenario starts the server over its own recording owner on a fresh loopback listener, speaks to it
 * through the client and raw HTTP, and closes it before the next one.
 */
export interface TransportConformanceBinding {
  readonly providerId: string
  readonly recipe: string
  readonly command: string
  readonly build: BuildIdentity
  /** Hex digests of the server code, its options and the release set it ships in. */
  readonly providerDigest: string
  readonly configDigest: string
  readonly releaseSetDigest: string
  /** The admissions the listener offers. Deny runs every one; the other scenarios run the first. */
  readonly admissions: readonly TransportAdmission['kind'][]
  /** Starts the server over `backing` on a fresh loopback listener that admits only `admission`. */
  readonly start: (backing: TransportBacking, admission: TransportAdmission) => Promise<TransportServer>
  readonly client: (options: TransportClientOptions) => TransportClient
}

type Checks = Record<string, boolean>
type Detail = keyof typeof RuntimeErrorDetails

const CLIENT = 'conformance-client'
const ORIGIN = 'http://127.0.0.1:4177'
const CREDENTIAL = 'conformance-credential'
/** A conversation the owner refuses every command for. */
const CLOSED_SESSION = 'vault'
const HELLO: Wire.ClientHello = {
  capabilities: {
    clientInstanceId: CLIENT,
    target: 'sdk',
    protocols: [{ major: WIRE_MAJOR, minMinor: 0, maxMinor: 0 }],
    viewSchemaRanges: [],
    renderKeys: [],
    features: [RuntimeClientTransportWire.feature],
    capabilitiesRevision: 1,
    interaction: { text: true, singleChoice: true, multiChoice: true, confirm: true, complexFormLink: false },
    files: { link: true, upload: false, maxUploadBytes: 0, allowedMimes: [] },
    display: { plainText: true, markdown: true, maxTextBytes: 1024, inlinePreviewMimes: [] },
  },
  authorApi: [],
  loadedBundles: [],
}
const OTHER_MAJOR: Wire.ClientHello = {
  ...HELLO,
  capabilities: { ...HELLO.capabilities, protocols: [{ major: WIRE_MAJOR + 1, minMinor: 0, maxMinor: 0 }] },
}
const HEADER: Wire.ClientCallHeader = {
  negotiatedSession: 'session-1',
  clientInstanceId: CLIENT,
  catalogRevision: 1,
  callId: 'call-1',
}
const SCOPE = {
  kind: 'workspace',
  installationId: 'conformance',
  runtimeId: 'conformance',
  workspaceId: 'conformance',
} as const
const INTERACTIONS = { topic: 'interactions', input: { scope: SCOPE } } as const
const cancel = (requestId: string, sessionId = 'conversation-1') => ({ sessionId, runId: 'run-1', requestId })

const schema = (n: number): Wire.SchemaRef => ({
  typeId: `conformance.transport/item${n}@1`,
  revision: 1,
  digest: canonicalJsonDigest(n),
})
const module = (n: number): Wire.ClientModule => ({
  moduleId: `conformance.module-${n}`,
  packageId: 'conformance.transport',
  packageDigest: canonicalJsonDigest('package'),
  assetDigest: canonicalJsonDigest(`asset-${n}`),
  entryPath: 'index.js',
  ownerToken: 'owner',
  authorApiMajor: 1,
  targets: ['sdk'],
  schemas: [schema(n)],
  requiredFeatures: [],
  styles: [],
})
const handle = (requestId: string, accepted: boolean): Wire.CommandHandle =>
  accepted
    ? {
        commandId: `command-${requestId}`,
        requestId,
        revision: 1,
        completion: 'runtime-accepted',
        status: 'accepted',
        result: null,
        error: null,
      }
    : {
        requestId,
        status: 'not-accepted',
        commandId: null,
        revision: null,
        completion: null,
        result: null,
        error: null,
      }
const SNAPSHOT = {
  page: { items: [], snapshot: 'snapshot-1', nextCursor: null, complete: true },
  nextCursor: null,
  complete: true,
}
const frame = (subscriptionId: string, kind: 'snapshot' | 'change' | 'end', cursor: string) =>
  ({
    subscriptionId,
    topic: 'interactions',
    kind,
    cursor,
    payload:
      kind === 'snapshot'
        ? SNAPSHOT
        : kind === 'change'
          ? { kind: 'remove', interactionId: `interaction-${cursor}`, version: 1, reason: 'gone' }
          : { reason: 'done' },
  }) as Wire.ClientSubscriptionFrame
/** Every frame after the snapshot, served at most two a page. */
const LATER = [
  ['change', 'c1'],
  ['change', 'c2'],
  ['end', 'c3'],
] as const

const refusal = (detail: Detail): Outcome<never> => ({
  ok: false,
  error: {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message: detail,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'transport-conformance',
  },
})

type Held = 'conversation.cancel' | 'readSubscription'
type Delivery = {
  readonly operation: Wire.ClientJsonOperation
  readonly input: unknown
  readonly header: Wire.ClientCallHeader
}

/** The recording owner one case runs over: a conversation command, its status and interaction frames. */
function createOwner(options: { mode?: 'compatible' | 'reload-required'; wireMajor?: number } = {}) {
  const mode = options.mode ?? 'compatible'
  const hellos: Wire.ClientHello[] = []
  const pages: Wire.ClientCatalogPageRequest[] = []
  const deliveries: Delivery[] = []
  const reads: (string | null)[] = []
  const closes: string[] = []
  const committed = new Set<string>()
  const open = new Set<string>()
  const holds = new Map<Held, { begin(): void; wait: Promise<void> }>()
  let seen = 0
  let sessions = 0
  let subscriptions = 0
  let corrupt = false
  const held = async (name: Held) => {
    const hold = holds.get(name)
    holds.delete(name)
    if (!hold) return
    hold.begin()
    await hold.wait
  }
  const owner = {
    hellos,
    pages,
    deliveries,
    reads,
    closes,
    /** How many requests reached the owner at all. */
    seen: () => seen,
    /** How many times a command with this request id reached the owner. */
    count: (requestId: string) =>
      deliveries.filter(
        (delivery) =>
          delivery.operation === 'conversation.cancel' &&
          (delivery.input as { requestId?: unknown }).requestId === requestId,
      ).length,
    /** Holds the next call named `name` until `release`; `started` settles once it waits. */
    hold(name: Held) {
      let begin = (): void => undefined
      let release = (): void => undefined
      const started = new Promise<void>((resolve) => {
        begin = resolve
      })
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      holds.set(name, { begin, wait })
      return { started, release }
    },
    /** The next catalog status leaves the owner outside its registered shape. */
    corrupt() {
      corrupt = true
    },
    operations: ['conversation.cancel', 'conversation.status', 'transport.catalogStatus'],
    async bootstrap(hello) {
      seen++
      hellos.push(hello)
      if (!hello.capabilities.protocols.some((protocol) => protocol.major === WIRE_MAJOR))
        return {
          ok: true,
          value: {
            mode: 'incompatible',
            reasonCode: 'wire_major',
            message: 'no common wire major',
            supportedProtocols: [{ major: WIRE_MAJOR, minMinor: 0, maxMinor: 0 }],
          },
        }
      const negotiatedSession = `session-${++sessions}`
      return {
        ok: true,
        value: {
          welcome: {
            negotiatedSession,
            wireVersion: { major: options.wireMajor ?? WIRE_MAJOR, minor: 0 },
            catalogRevision: 1,
            capabilities: { ...hello.capabilities, negotiatedSession, effectivePolicyRevision: 1 },
            modules: [module(1)],
            domainSchemas: [schema(1)],
            mode,
            reasons: [],
            clientInstanceId: hello.capabilities.clientInstanceId,
          },
          catalogPage: { nextCursor: 'page-2', complete: false },
        },
      }
    },
    async catalogPage(request) {
      seen++
      pages.push(request)
      return request.cursor === 'page-2' && request.catalogRevision === 1
        ? {
            ok: true,
            value: {
              catalogRevision: 1,
              modules: [module(2)],
              domainSchemas: [schema(2)],
              nextCursor: null,
              complete: true,
            },
          }
        : refusal('catalog_changed')
    },
    async call(operation, input, header) {
      seen++
      deliveries.push({ operation, input, header })
      if (operation === 'conversation.cancel') {
        await held('conversation.cancel')
        const { requestId, sessionId } = input as ReturnType<typeof cancel>
        if (sessionId === CLOSED_SESSION) return refusal('permission_denied')
        committed.add(requestId)
        return { ok: true, value: handle(requestId, true) }
      }
      if (operation === 'conversation.status')
        return { ok: true, value: handle(input as string, committed.has(input as string)) }
      if (operation !== 'transport.catalogStatus') return refusal('operation_not_supported')
      if (!corrupt) return { ok: true, value: { catalogRevision: 1, mode, reasonCode: null } }
      corrupt = false
      return { ok: true, value: { catalogRevision: 'one' } }
    },
    async subscribe(request) {
      seen++
      const subscriptionId = `subscription-${++subscriptions}`
      open.add(subscriptionId)
      return {
        ok: true,
        value: {
          header: request.header,
          subscriptionId,
          topic: 'interactions',
          cursor: 'c0',
          frame: frame(subscriptionId, 'snapshot', 'c0'),
        } as Wire.ClientSubscribeResult,
      }
    },
    async readSubscription(request) {
      seen++
      reads.push(request.cursor)
      await held('readSubscription')
      if (!open.has(request.subscriptionId)) return refusal('not_found')
      const from = LATER.findIndex(([, cursor]) => cursor === request.cursor) + 1
      const frames = LATER.slice(from, from + 2).map(([kind, cursor]) =>
        frame(request.subscriptionId, kind, cursor),
      )
      return {
        ok: true,
        value: {
          header: request.header,
          frames,
          nextCursor: frames.at(-1)?.cursor ?? request.cursor,
          hasMore: from + 2 < LATER.length,
        },
      }
    },
    async closeSubscription(request) {
      seen++
      closes.push(request.subscriptionId)
      open.delete(request.subscriptionId)
      return { ok: true, value: { closed: true } }
    },
  } satisfies TransportBacking & Record<string, unknown>
  return owner
}
type Owner = ReturnType<typeof createOwner>

type Answer = { readonly status: number; readonly headers: Record<string, string>; readonly body: Buffer }
type Exchange = {
  readonly method?: string
  readonly headers: Record<string, string>
  readonly body?: string | Uint8Array
  /** Written one by one, so the body goes out chunked with no declared length. */
  readonly chunks?: readonly Uint8Array[]
  /** A declared body length; no body follows, so only the declaration can be judged. */
  readonly declared?: number
  readonly signal?: AbortSignal
  readonly ca?: string
}

/** One HTTP exchange on a fresh connection; raw so that a forged Host or an unsent body can be sent. */
function exchange(url: string, init: Exchange): Promise<Answer> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: init.method ?? 'POST',
      headers:
        init.declared === undefined
          ? init.headers
          : { ...init.headers, 'content-length': String(init.declared) },
      agent: false,
      ...(init.ca === undefined ? {} : { ca: init.ca }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
    request.on('error', reject)
    // A server that never answers, such as one waiting on a declared body, fails the case instead of
    // holding the run until its own request timeout.
    request.setTimeout(10_000, () => request.destroy(new Error('timed out: no reply from the server')))
    request.once('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.once('close', () => {
        if (!response.complete) reject(new Error('the connection closed before the reply ended'))
      })
      response.once('end', () => {
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(response.headers))
          if (typeof value === 'string') headers[name] = value
        resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) })
        if (init.declared !== undefined) request.destroy()
      })
    })
    if (init.declared !== undefined) return void request.flushHeaders()
    for (const chunk of init.chunks ?? []) request.write(chunk)
    request.end(init.body)
  })
}

/** What can go wrong between the client and the server: the request lost before the server, the reply
 * lost or cut off half way after it, or the request delivered twice. */
type Fault = 'drop' | 'lose' | 'cut' | 'duplicate'

interface Run {
  readonly owner: Owner
  readonly admission: TransportAdmission
  readonly server: TransportServer
  /** Arms a fault for the next request to `path`. */
  fault(path: string, fault: Fault): void
  client(options?: { journal?: string; hello?: Wire.ClientHello; admitted?: boolean }): TransportClient
  /** Closes the server, cutting its connections, and starts a new one over the same owner. */
  restart(): Promise<void>
}

let journals = 0
const journal = () => `transport-conformance-${++journals}`

/** Fails a wait that would otherwise hang the run. */
function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const admissionOf = (kind: TransportAdmission['kind']): TransportAdmission =>
  kind === 'bearer' ? { kind, credential: CREDENTIAL } : { kind, origin: ORIGIN }
/** The headers an admitted request carries; a browser page sends its Origin itself. */
const admitted = (admission: TransportAdmission): Record<string, string> =>
  admission.kind === 'bearer'
    ? { authorization: `Bearer ${admission.credential}` }
    : { origin: admission.origin }

/** Starts the binding's server over `owner`, runs `use` and closes every server it started. */
async function withServer(
  binding: TransportConformanceBinding,
  owner: Owner,
  use: (run: Run) => Promise<void>,
  kind = binding.admissions[0],
): Promise<void> {
  if (kind === undefined) throw new Error('the binding declares no admission')
  const admission = admissionOf(kind)
  const started: TransportServer[] = []
  const start = async () => {
    const server = await binding.start(owner, admission)
    started.push(server)
    return server
  }
  try {
    let server = await start()
    const faults = new Map<string, Fault>()
    const network =
      (admit: boolean): TransportFetch =>
      async (url, init) => {
        const path = new URL(url).pathname
        const fault = faults.get(path)
        faults.delete(path)
        if (fault === 'drop') throw new TypeError('the request was lost')
        const request: Exchange = {
          method: init.method ?? 'GET',
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            ...(admit && admission.kind === 'page-origin' ? { origin: admission.origin } : {}),
          },
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
          ...(server.ca === undefined ? {} : { ca: server.ca }),
        }
        const answer = await exchange(url, request)
        if (fault === 'duplicate') await exchange(url, request)
        if (fault === 'lose') throw new TypeError('the reply was lost')
        const body = fault === 'cut' ? answer.body.subarray(0, answer.body.length >> 1) : answer.body
        return new Response(body.length > 0 ? new Uint8Array(body) : null, {
          status: answer.status,
          headers: answer.headers,
        })
      }
    await use({
      owner,
      admission,
      get server() {
        return server
      },
      fault: (path, fault) => void faults.set(path, fault),
      client: ({ journal: name = journal(), hello = HELLO, admitted: admit = true } = {}) =>
        binding.client({
          baseUrl: server.baseUrl,
          hello,
          journal: name,
          fetch: network(admit),
          pollIntervalMs: 5,
          ...(admit && admission.kind === 'bearer' ? { credential: admission.credential } : {}),
        }),
      async restart() {
        await within(server.close(), 'closing the server')
        server = await start()
      },
    })
  } finally {
    await within(Promise.all(started.map((server) => server.close())), 'closing the servers')
  }
}

/** A raw request to the run's server: admitted JSON unless `headers` says otherwise. */
function raw(run: Run, path: string, init: Partial<Exchange> = {}): Promise<Answer> {
  return exchange(run.server.baseUrl + path, {
    ...init,
    headers: init.headers ?? { 'content-type': JSON_TYPE, ...admitted(run.admission) },
    ...(run.server.ca === undefined ? {} : { ca: run.server.ca }),
  })
}
/** `status detailCode` of a typed refusal, or the bare status of anything else. */
function typed(answer: Answer): string {
  try {
    const body = JSON.parse(answer.body.toString('utf8')) as {
      ok?: unknown
      error?: { detailCode?: unknown }
    }
    return body.ok === false ? `${answer.status} ${String(body.error?.detailCode)}` : String(answer.status)
  } catch {
    return String(answer.status)
  }
}
const refused = (detail: Detail) => `${RuntimeErrorDetails[detail].httpStatus} ${detail}`
const call = (operation: string, input: unknown) =>
  JSON.stringify({ header: HEADER, call: { operation, input } })
const drain = async (subscription: TransportSubscription) => {
  const seen: string[] = []
  for await (const item of subscription.frames) seen.push(`${item.kind} ${item.cursor}`)
  return seen
}
/** The header the owner sees carries the welcome's session fields and a call id of the client's. */
const sameSession = (header: Wire.ClientCallHeader | undefined) =>
  header?.negotiatedSession === 'session-1' &&
  header.clientInstanceId === CLIENT &&
  header.catalogRevision === 1 &&
  typeof header.callId === 'string'

const CASES: Record<ScenarioName, (binding: TransportConformanceBinding) => Promise<Checks>> = {
  async select(binding) {
    const checks: Checks = {}
    await withServer(binding, createOwner(), async (run) => {
      const client = run.client()
      await client.connect()
      checks['a client offering the served wire major is welcomed as compatible'] =
        client.mode === 'compatible' &&
        run.owner.hellos.length === 1 &&
        jcs(run.owner.hellos[0]) === jcs(HELLO)
      const sent = await client.command('conversation.cancel', cancel('select-1'))
      checks['the catalog is read to completion before a command leaves'] =
        run.owner.pages.length === 1 && run.owner.pages[0]?.cursor === 'page-2' && sent.state === 'ok'
      const answers = []
      for (const name of JSON_ROUTES) answers.push(typed(await raw(run, routes[name].path, { body: '{}' })))
      checks['each JSON route of the generated table answers on its own path'] = answers.every(
        (answer) => answer === refused('invalid_request'),
      )
    })
    for (const [name, owner, hello] of [
      ['a hello offering only another wire major', createOwner(), OTHER_MAJOR],
      ['a welcome of another wire major', createOwner({ wireMajor: WIRE_MAJOR + 1 }), HELLO],
    ] as const)
      await withServer(binding, owner, async (run) => {
        const client = run.client({ hello })
        await client.connect()
        const read = await client.query('conversation.status', 'select-2')
        const write = await client.command('conversation.cancel', cancel('select-2'))
        checks[`${name} leaves the client incompatible and no call reaches the owner`] =
          client.mode === 'incompatible' &&
          read.state === 'refused' &&
          write.state === 'refused' &&
          owner.deliveries.length === 0
      })
    await withServer(binding, createOwner({ mode: 'reload-required' }), async (run) => {
      const client = run.client()
      await client.connect()
      const read = await client.query('conversation.status', 'select-3')
      const write = await client.command('conversation.cancel', cancel('select-3'))
      checks['a reload-required session still reads but sends no new command'] =
        client.mode === 'reload-required' &&
        read.state === 'ok' &&
        write.state === 'refused' &&
        write.reason === 'reload-required' &&
        run.owner.count('select-3') === 0
    })
    return checks
  },

  async normal(binding) {
    const checks: Checks = {}
    await withServer(binding, createOwner(), async (run) => {
      const client = run.client()
      await client.connect()
      const input = cancel('normal-1')
      const sent = await client.command('conversation.cancel', input)
      const [delivery] = run.owner.deliveries
      checks['a command reaches the owner once, with its input and the session header'] =
        sent.state === 'ok' &&
        sent.value.requestId === 'normal-1' &&
        sent.value.status === 'accepted' &&
        run.owner.deliveries.length === 1 &&
        delivery?.operation === 'conversation.cancel' &&
        jcs(delivery.input) === jcs(input) &&
        sameSession(delivery.header)
      checks['an accepted command leaves nothing pending'] = (await client.pending()).length === 0
      const status = await client.query('conversation.status', 'normal-1')
      checks['a query answers from the owner'] = status.state === 'ok' && status.value.status === 'accepted'
      const current = { catalogRevision: 1, mode: 'compatible', reasonCode: null }
      const catalog = await client.query('transport.catalogStatus', { header: HEADER })
      checks['the catalog status query answers the current catalog'] =
        catalog.state === 'ok' && jcs(catalog.value) === jcs(current)
      const direct = await raw(run, routes.catalogStatus.path, { body: JSON.stringify({ header: HEADER }) })
      checks['the catalog status route answers the current catalog'] =
        direct.status === 200 &&
        jcs(JSON.parse(direct.body.toString('utf8'))) === jcs({ ok: true, value: current })
      const subscribed = await client.subscribe(INTERACTIONS)
      const subscription = subscribed.state === 'ok' ? subscribed.value : null
      const seen = subscription ? await within(drain(subscription), 'draining the subscription') : []
      checks['a subscription delivers each frame once, in order, until its end'] =
        subscription?.first.kind === 'snapshot' &&
        subscription.first.cursor === 'c0' &&
        jcs(seen) === jcs(['change c1', 'change c2', 'end c3']) &&
        (await subscription.ended).reason === 'end'
      checks['each poll resumes after the last delivered frame'] = jcs(run.owner.reads) === jcs(['c0', 'c2'])
      checks['a finished subscription leaves no listener behind'] = client.listeners.size === 0
    })
    return checks
  },

  async deny(binding) {
    const checks: Checks = {}
    if (binding.admissions.length === 0) return { 'the listener declares an admission': false }
    const hello = JSON.stringify(HELLO)
    for (const kind of binding.admissions)
      await withServer(
        binding,
        createOwner(),
        async (run) => {
          const forged: Record<string, Record<string, string>> = kind === 'bearer'
            ? {
                'no credential': {},
                'a wrong credential': { authorization: 'Bearer wrong-credential' },
                'the credential without its scheme': { authorization: CREDENTIAL },
              }
            : {
                'no Origin': {},
                'a foreign Origin': { origin: 'http://evil.example' },
                'a forged Host': { origin: ORIGIN, host: 'evil.example' },
              }
          for (const [name, headers] of Object.entries(forged)) {
            const answer = await raw(run, routes.bootstrap.path, {
              headers: { 'content-type': JSON_TYPE, ...headers },
              body: hello,
            })
            checks[`${kind}: a request with ${name} is refused`] =
              (answer.status === 401 || answer.status === 403) && !typed(answer).startsWith('200')
          }
          const outsider = run.client({ admitted: false })
          await outsider.connect().catch(() => undefined)
          const blocked = await outsider.command('conversation.cancel', cancel('deny-1'))
          checks[`${kind}: a client the listener does not admit is never connected`] =
            outsider.mode !== 'compatible' && blocked.state === 'refused'
          checks[`${kind}: no refused request reaches the owner`] = run.owner.seen() === 0
          const answer = await raw(run, routes.bootstrap.path, { body: hello })
          checks[`${kind}: the admitted request reaches the owner`] =
            answer.status === 200 && run.owner.hellos.length === 1
        },
        kind,
      )
    await withServer(binding, createOwner(), async (run) => {
      const bootstrap = routes.bootstrap.path
      const query = routes.clientQuery.path
      const bodies: [string, string, Partial<Exchange>, Detail][] = [
        ['a body declared over the JSON limit', bootstrap, { declared: LIMIT + 1 }, 'rpc_json_bytes'],
        [
          'a chunked body over the JSON limit',
          bootstrap,
          { chunks: [new Uint8Array(LIMIT), new Uint8Array(1)] },
          'rpc_json_bytes',
        ],
        [
          'a body of another media type',
          bootstrap,
          { body: hello, headers: { ...admitted(run.admission), 'content-type': 'text/plain' } },
          'invalid_request',
        ],
        ['malformed JSON', bootstrap, { body: '{"capabilities":' }, 'invalid_request'],
        ['a body that is not UTF-8', bootstrap, { body: Uint8Array.of(0x7b, 0xff, 0x7d) }, 'invalid_request'],
        [
          'a hello outside its schema',
          bootstrap,
          { body: JSON.stringify({ ...HELLO, capabilities: 1 }) },
          'invalid_request',
        ],
        [
          'an operation outside the generated table',
          query,
          { body: call('conformance.unknown', {}) },
          'invalid_request',
        ],
        [
          'a command sent as a query',
          query,
          { body: call('conversation.cancel', cancel('deny-2')) },
          'invalid_request',
        ],
        [
          'an operation the owner does not serve',
          query,
          { body: call('control.read', 'conversation-1') },
          'operation_not_supported',
        ],
        [
          'a route the owner does not serve',
          routes.streamStatus.path,
          { body: JSON.stringify({ header: HEADER, streamId: 'stream-1' }) },
          'operation_not_supported',
        ],
      ]
      for (const [name, path, init, detail] of bodies)
        checks[`${name} is refused as ${detail}`] = typed(await raw(run, path, init)) === refused(detail)
      checks['a wrong method is refused'] = (await raw(run, bootstrap, { method: 'GET' })).status === 405
      checks['a path outside the generated table is not served'] =
        (await raw(run, '/api/runtime/client/unknown', { body: hello })).status === 404
      checks['no refused request reaches the owner'] = run.owner.seen() === 0
      run.owner.corrupt()
      checks['a reply outside its registered shape never leaves the server'] =
        typed(await raw(run, query, { body: call('transport.catalogStatus', { header: HEADER }) })) ===
        refused('internal_error')
      const client = run.client()
      await client.connect()
      const denied = await client.command('conversation.cancel', cancel('deny-3', CLOSED_SESSION))
      checks["an owner's refusal reaches the client as the same typed error"] =
        denied.state === 'failed' &&
        denied.error.detailCode === 'permission_denied' &&
        (await client.pending()).length === 0
    })
    return checks
  },

  async cancel(binding) {
    const checks: Checks = {}
    await withServer(binding, createOwner(), async (run) => {
      const client = run.client()
      await client.connect()
      const hold = run.owner.hold('conversation.cancel')
      const controller = new AbortController()
      const sending = client.command('conversation.cancel', cancel('cancel-1'), controller.signal)
      await within(hold.started, 'the command reaching the owner')
      controller.abort()
      const aborted = await within(sending, 'the aborted command')
      hold.release()
      checks['an aborted command reports no outcome and stays pending'] =
        aborted.state === 'unknown' && jcs(await client.pending()) === jcs(['cancel-1'])
      const after = await client.query('conversation.status', 'cancel-1')
      checks['the server keeps serving after a client aborts'] =
        after.state === 'ok' && after.value.status === 'accepted'
      checks['the aborted command is never resent'] = run.owner.count('cancel-1') === 1
      const early = await client.command('conversation.cancel', cancel('cancel-2'), AbortSignal.abort())
      checks['a command aborted before it leaves never reaches the owner'] =
        early.state !== 'ok' && run.owner.count('cancel-2') === 0

      const read = run.owner.hold('readSubscription')
      const subscribed = await client.subscribe(INTERACTIONS)
      if (subscribed.state !== 'ok') {
        checks['a subscription opens'] = false
        return
      }
      const subscription = subscribed.value
      const draining = drain(subscription)
      await within(read.started, 'the poll reaching the owner')
      const closed = await subscription.close()
      read.release()
      checks['closing a subscription with a poll in flight ends it at once'] =
        closed.state === 'ok' &&
        (await subscription.ended).reason === 'closed' &&
        (await within(draining, 'the closed subscription')).length === 0 &&
        jcs(run.owner.closes) === jcs([subscription.subscriptionId]) &&
        client.listeners.size === 0
    })
    return checks
  },

  async recover(binding) {
    const checks: Checks = {}
    await withServer(binding, createOwner(), async (run) => {
      const name = journal()
      const client = run.client({ journal: name })
      await client.connect()
      const statuses = () =>
        run.owner.deliveries
          .filter((item) => item.operation === 'conversation.status')
          .map((item) => item.input)
      const command = routes.clientCommand.path
      for (const [label, fault, id] of [
        ['a reply lost after the owner accepted', 'lose', 'recover-1'],
        ['a reply cut off half way', 'cut', 'recover-2'],
      ] as const) {
        run.fault(command, fault)
        const sent = await client.command('conversation.cancel', cancel(id))
        checks[`${label} is reported without an outcome and not resent`] =
          sent.state === 'unknown' && run.owner.count(id) === 1
        const reports = await client.recover()
        checks[`${label} is recovered by the status of the same request id`] =
          jcs(reports) === jcs([{ id, operation: 'conversation.cancel', state: 'accepted' }]) &&
          statuses().includes(id) &&
          run.owner.count(id) === 1 &&
          (await client.pending()).length === 0
      }
      run.fault(command, 'duplicate')
      const twice = await client.command('conversation.cancel', cancel('recover-3'))
      const copies = run.owner.deliveries.filter(
        (item) => (item.input as { requestId?: unknown }).requestId === 'recover-3',
      )
      checks['a request the network delivers twice reaches the owner unchanged under its request id'] =
        twice.state === 'ok' &&
        copies.length === 2 &&
        copies.every((item) => jcs(item.input) === jcs(cancel('recover-3')))
      run.fault(command, 'drop')
      const dropped = await client.command('conversation.cancel', cancel('recover-4'))
      const unsent = await client.recover()
      checks['a request lost before the owner stays pending and is never resent'] =
        dropped.state === 'unknown' &&
        jcs(unsent) === jcs([{ id: 'recover-4', operation: 'conversation.cancel', state: 'not-accepted' }]) &&
        run.owner.count('recover-4') === 0 &&
        jcs(await client.pending()) === jcs(['recover-4'])

      const hold = run.owner.hold('conversation.cancel')
      const cut = client.command('conversation.cancel', cancel('recover-5'))
      await within(hold.started, 'the command reaching the owner')
      await run.restart()
      const lost = await within(cut, 'the command on the closed connection')
      hold.release()
      const reloaded = run.client({ journal: name })
      await reloaded.connect()
      const reports = await reloaded.recover()
      checks['a connection the server drops leaves its command without an outcome'] = lost.state === 'unknown'
      checks['a reloaded client recovers it from the restarted server without resending'] =
        reports.some((report) => report.id === 'recover-5' && report.state === 'accepted') &&
        statuses().includes('recover-5') &&
        run.owner.count('recover-5') === 1
    })
    return checks
  },

  async dispose(binding) {
    const checks: Checks = {}
    await withServer(binding, createOwner(), async (run) => {
      const client = run.client()
      await client.connect()
      const subscribed = await client.subscribe(INTERACTIONS)
      if (subscribed.state !== 'ok') {
        checks['a subscription opens'] = false
        return
      }
      const subscription = subscribed.value
      const first = await subscription.close()
      const second = await subscription.close()
      checks['closing a subscription ends it and releases its listener'] =
        first.state === 'ok' && (await subscription.ended).reason === 'closed' && client.listeners.size === 0
      checks['the owner hears one close however often the client closes'] =
        jcs(second) === jcs(first) && jcs(run.owner.closes) === jcs([subscription.subscriptionId])
      const before = run.owner.seen()
      const server = run.server
      await within(server.close(), 'closing the server')
      await within(server.close(), 'closing the server again')
      const late = await client.query('conversation.status', 'dispose-1')
      checks['a call after the server closed gets no reply and never reaches the owner'] =
        late.state === 'unknown' && run.owner.seen() === before
      checks['the closed listener accepts no connection'] = await raw(run, routes.bootstrap.path, {
        body: JSON.stringify(HELLO),
      }).then(
        () => false,
        () => true,
      )
    })
    return checks
  },
}

/** The names of the failed checks, or the error a case threw. */
async function failures(scenario: ScenarioName, binding: TransportConformanceBinding): Promise<string[]> {
  const digests = [binding.providerDigest, binding.configDigest, binding.releaseSetDigest]
  if (!digests.every((digest) => HEX.test(digest))) return ['provider, config or release set digest']
  try {
    return Object.entries(await CASES[scenario](binding))
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
  } catch (error) {
    // A server or client that throws fails its scenario instead of ending the run.
    return [`threw: ${error instanceof Error ? error.message : String(error)}`]
  }
}

const LIFECYCLE: Record<ScenarioName, ReuseLifecycle> = {
  select: 'call',
  normal: 'call',
  deny: 'call',
  cancel: 'cancel',
  recover: 'recover',
  dispose: 'dispose',
}

/** Register select, normal, deny, cancel, recover and dispose for one runtime client transport. */
export function registerTransportContract(
  harness: ConformanceHarness,
  binding: TransportConformanceBinding,
): void {
  for (const scenario of SCENARIOS) {
    harness.registerCase({
      contract: CONTRACT,
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run(): Promise<AssertionInput> {
        const failed = await failures(scenario, binding)
        const diagnostic = failed.join('; ')
        return {
          id: `${CONTRACT}/${binding.providerId}/${scenario}`,
          providerDigest: binding.providerDigest,
          recipe: binding.recipe,
          features: [...JSON_ROUTES],
          build: binding.build,
          consumer: `${CONTRACT}-conformance-consumer`,
          command: binding.command,
          status: failed.length === 0 ? 'passed' : 'failed',
          ...(diagnostic ? { diagnostic } : {}),
          configDigest: binding.configDigest,
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'run',
            methodKind: 'ingress',
            lifecycle: LIFECYCLE[scenario],
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
  }
}
