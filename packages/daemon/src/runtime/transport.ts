// The daemon end of the runtime client wire over HTTP. Every route of the generated table except the
// push socket is matched here by method and path; its request is bounded, parsed and validated
// before the injected port for its operation sees it, and a route or operation without a port
// answers the typed `operation_not_supported` refusal. The listener authenticates each request
// before it reaches this module, which grants no authority of its own.
//
// Subscriptions are read by polling. A subscription is readable only by the negotiated session that
// opened it through these routes; one this module does not hold, because it was closed, ended, opened
// by another session or before a restart, answers `resync_required` without reaching the owner, so the
// client subscribes again and starts from a fresh snapshot. A reader that does not poll within the
// policy's idle timeout is closed at its owner. Cancellations and other control commands pass through
// their own bounded channel, so work traffic never counts against them.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type * as Wire from '@agnes/protocol/runtime'
import {
  clientCommandQuotaClass,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  runtimeErrorHttpStatus,
  validateClientBinaryRequest,
  validateClientCommandRequest,
  validateClientQueryRequest,
  validateClientReply,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'

const { routes, jsonMime } = RuntimeClientTransportWire
const {
  readerIdleTimeoutMs,
  controlMaxConcurrentPerWorkspace,
  controlMaxRequestsPerPrincipalPerMinute,
  controlWindowMs,
} = RuntimeClientTransportPolicy
const downloadPrefix = routes.download.path.replace('{ticketId}', '')

// Same shape as the HTTP Outcome body and the Local SPI Outcome; they meet structurally at assembly.
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: Wire.RuntimeError }
type Port<I, O> = (request: I) => Promise<Outcome<O>>

/** Backend ports by operation. A JSON operation's port also receives its call header; a transport
 * route without an operation of its own takes its validated request. */
export type RuntimeClientPorts = {
  readonly [K in Wire.ClientJsonOperation]?: (
    input: Wire.ClientOperationTypes[K]['input'],
    header: Wire.ClientCallHeader,
  ) => Promise<Outcome<Wire.ClientOperationTypes[K]['output']>>
} & {
  readonly bootstrap?: Port<Wire.ClientHello, Wire.ClientBootstrapResult>
  readonly catalogPage?: Port<Wire.ClientCatalogPageRequest, Wire.ClientCatalogPageResult>
  readonly subscribe?: Port<Wire.ClientSubscribeRequest, Wire.ClientSubscribeResult>
  readonly readSubscription?: Port<Wire.ClientReadSubscriptionRequest, Wire.ClientReadSubscriptionResult>
  readonly closeSubscription?: Port<Wire.ClientCloseSubscriptionRequest, Wire.ClientCloseSubscriptionResult>
}

/** The push socket is an upgrade, outside this module; every other generated route is served. */
type Served = Exclude<keyof typeof routes, 'websocket'>

const failure = (
  detailCode: string,
  code: Wire.RuntimeError['code'],
  message: string,
  retryAdvice: Wire.RuntimeError['retryAdvice'] = { kind: 'never' },
): Outcome<never> => ({
  ok: false,
  error: { code, detailCode, message, retryAdvice, diagnosticId: randomUUID() },
})
const invalid = () => failure('invalid_request', 'invalid_input', 'invalid runtime client request')
const tooLarge = () => failure('rpc_json_bytes', 'quota', 'runtime client request exceeds the JSON limit')
const unsupported = () =>
  failure('operation_not_supported', 'incompatible', 'runtime client operation is not wired to a backend')
const broken = () => failure('internal_error', 'internal', 'runtime client backend failed')
const resync = () =>
  failure('resync_required', 'conflict', 'runtime subscription must be opened again', { kind: 'retry_read' })

/** A port's outcome leaves only in its registered shape; a throw or anything else is internal. */
async function run(port: () => Promise<Outcome<unknown>>, valid: (value: unknown) => boolean) {
  try {
    const outcome = await port()
    return (outcome.ok ? valid(outcome.value) : validateRuntimeErrorDetail(outcome.error).ok)
      ? outcome
      : broken()
  } catch {
    return broken()
  }
}

/** The JSON body within the policy's byte limit; nothing past the limit is buffered. */
async function read(request: IncomingMessage): Promise<Outcome<unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== jsonMime) return invalid()
  const limit = RuntimeClientTransportPolicy.maxJsonBytes
  if (Number(request.headers['content-length']) > limit) return tooLarge()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size <= limit) chunks.push(chunk)
  }
  if (size > limit) return tooLarge()
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),
    }
  } catch {
    return invalid()
  }
}

/** The redeem request a download URL and its optional open-ended `Range` header carry. */
function download(path: string, query: string, range: string | undefined): Outcome<unknown> {
  const params = new URLSearchParams(query)
  const offset = range === undefined ? '0' : /^bytes=(\d+)-$/.exec(range)?.[1]
  if (offset === undefined || [...params.keys()].join() !== 'nonce') return invalid()
  try {
    const ticketId = decodeURIComponent(path.slice(downloadPrefix.length))
    return { ok: true, value: { ticketId, nonce: params.get('nonce'), offset: Number(offset) } }
  } catch {
    return invalid()
  }
}

/** A body left unread, such as an oversized one, is not drained to keep the connection alive. */
const unread = (request: IncomingMessage) => (request.complete ? {} : { Connection: 'close' })

function send(request: IncomingMessage, response: ServerResponse, outcome: Outcome<unknown>): void {
  response.writeHead(outcome.ok ? 200 : runtimeErrorHttpStatus(outcome.error), {
    'Content-Type': `${jsonMime}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...unread(request),
  })
  response.end(
    JSON.stringify(outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error }),
  )
}

export type RuntimeClientRoutes = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>

export type RuntimeClientRouteOptions = {
  /** Runs `task` once after `ms` and returns its cancel; the default never holds the process open. */
  schedule?: (task: () => void, ms: number) => () => void
  /** Epoch milliseconds; the control channel's rate window reads it. */
  now?: () => number
}

const schedule = (task: () => void, ms: number) => {
  const timer = setTimeout(task, ms).unref()
  return () => clearTimeout(timer)
}

/** A subscription opened through these routes: who opened it, and its idle timer while unread. */
type Reader = {
  session: string
  client: string
  header: Wire.ClientCallHeader
  reads: number
  stop: () => void
}

export function runtimeClientRoutes(
  ports: RuntimeClientPorts,
  options: RuntimeClientRouteOptions = {},
): RuntimeClientRoutes {
  const after = options.schedule ?? schedule
  const now = options.now ?? Date.now

  // ponytail: one control channel per route table, which serves one principal and workspace today;
  // key both bounds by principal and workspace once a listener serves several.
  let controlInFlight = 0
  const controlAdmitted: number[] = []
  /** A control request runs only within its own concurrency and rate bounds, never queued behind work. */
  const control = async (task: () => Promise<Outcome<unknown>>): Promise<Outcome<unknown>> => {
    const at = now()
    while (controlAdmitted.length && (controlAdmitted[0] as number) <= at - controlWindowMs)
      controlAdmitted.shift()
    if (controlAdmitted.length >= controlMaxRequestsPerPrincipalPerMinute) {
      const notBefore = new Date((controlAdmitted[0] as number) + controlWindowMs).toISOString()
      return failure('rate_limit', 'quota', 'runtime client control rate exceeded', {
        kind: 'retry_read',
        notBefore,
      })
    }
    if (controlInFlight >= controlMaxConcurrentPerWorkspace)
      return failure('control_concurrency', 'quota', 'too many runtime client control requests in flight', {
        kind: 'retry_read',
      })
    controlAdmitted.push(at)
    controlInFlight++
    try {
      return await task()
    } finally {
      controlInFlight--
    }
  }

  // ponytail: readers are bounded only by the idle timeout; cap them per session if a client opening
  // many subscriptions at once is ever seen.
  const readers = new Map<string, Reader>()
  /** The reader of `subscriptionId` when the same negotiated session and client instance opened it. */
  const reader = (header: Wire.ClientCallHeader, subscriptionId: string) => {
    const held = readers.get(subscriptionId)
    return held?.session === header.negotiatedSession && held.client === header.clientInstanceId
      ? held
      : undefined
  }
  const forget = (subscriptionId: string) => {
    readers.get(subscriptionId)?.stop()
    readers.delete(subscriptionId)
  }
  /** Closes a reader at its owner once it has gone unread for the idle timeout. */
  const idle = (subscriptionId: string, held: Reader) => {
    held.stop = after(() => {
      if (readers.get(subscriptionId) !== held) return
      readers.delete(subscriptionId)
      const close = ports.closeSubscription
      const request = { header: { ...held.header, callId: randomUUID() }, subscriptionId }
      if (close)
        void Promise.resolve()
          .then(() => close(request))
          .catch(() => undefined)
    }, readerIdleTimeoutMs)
  }
  const terminal = (frame: Wire.ClientSubscriptionFrame) => frame.kind === 'end' || frame.kind === 'error'

  const via =
    <I>(name: Served, validate: (value: unknown) => Wire.ValidationResult<I>, port?: Port<I, unknown>) =>
    async (body: unknown): Promise<Outcome<unknown>> => {
      const request = validate(body)
      if (!request.ok) return invalid()
      const output = routes[name].output
      return port
        ? run(
            () => port(request.value),
            (value) => validateRuntime(output, value).ok,
          )
        : unsupported()
    }
  /** A JSON call reaches the port of its operation; the reply carries the call's own header. */
  const dispatch = async (request: Wire.ClientQueryRequest | Wire.ClientCommandRequest) => {
    const { header, call } = request
    const port = ports[call.operation] as
      | ((input: unknown, header: Wire.ClientCallHeader) => Promise<Outcome<unknown>>)
      | undefined
    if (!port) return unsupported()
    return run(
      async () => {
        const outcome = await port(call.input, header)
        return outcome.ok
          ? { ok: true, value: { header, reply: { operation: call.operation, value: outcome.value } } }
          : outcome
      },
      (value) => validateClientReply(request, value).ok,
    )
  }
  const catalogStatus = ports['transport.catalogStatus']
  const streamStatus = ports['transport.streamStatus']
  const handlers: Record<Served, (body: unknown) => Promise<Outcome<unknown>>> = {
    bootstrap: via('bootstrap', (value) => validateRuntime('ClientHello', value), ports.bootstrap),
    clientQuery: async (body) => {
      const request = validateClientQueryRequest(body)
      return request.ok ? dispatch(request.value) : invalid()
    },
    clientCommand: async (body) => {
      const request = validateClientCommandRequest(body)
      if (!request.ok) return invalid()
      const quota = clientCommandQuotaClass(request.value)
      return quota.ok && quota.value === 'control'
        ? control(() => dispatch(request.value))
        : dispatch(request.value)
    },
    catalogPage: via(
      'catalogPage',
      (value) => validateRuntime('ClientCatalogPageRequest', value),
      ports.catalogPage,
    ),
    subscribe: async (body) => {
      const request = validateRuntime('ClientSubscribeRequest', body)
      const port = ports.subscribe
      if (!request.ok) return invalid()
      if (!port) return unsupported()
      const outcome = await run(
        () => port(request.value),
        (value) => validateRuntime('ClientSubscribeResult', value).ok,
      )
      if (outcome.ok) {
        const { subscriptionId, frame } = outcome.value as Wire.ClientSubscribeResult
        const { header } = request.value
        forget(subscriptionId)
        if (!terminal(frame)) {
          const held: Reader = {
            session: header.negotiatedSession,
            client: header.clientInstanceId,
            header,
            reads: 0,
            stop: () => undefined,
          }
          readers.set(subscriptionId, held)
          idle(subscriptionId, held)
        }
      }
      return outcome
    },
    readSubscription: async (body) => {
      const request = validateRuntime('ClientReadSubscriptionRequest', body)
      const port = ports.readSubscription
      if (!request.ok) return invalid()
      if (!port) return unsupported()
      const { header, subscriptionId } = request.value
      const held = reader(header, subscriptionId)
      if (!held) return resync()
      held.stop()
      held.header = header
      held.reads++
      try {
        const outcome = await run(
          () => port(request.value),
          (value) => validateRuntime('ClientReadSubscriptionResult', value).ok,
        )
        // An end or error frame ends the subscription at its owner; nothing more is read from it.
        if (outcome.ok && (outcome.value as Wire.ClientReadSubscriptionResult).frames.some(terminal))
          forget(subscriptionId)
        return outcome
      } finally {
        if (--held.reads === 0 && readers.get(subscriptionId) === held) idle(subscriptionId, held)
      }
    },
    closeSubscription: async (body) => {
      const request = validateRuntime('ClientCloseSubscriptionRequest', body)
      const port = ports.closeSubscription
      if (!request.ok) return invalid()
      if (!port) return unsupported()
      // Closing what this session does not hold is a no-op the owner never hears of.
      if (!reader(request.value.header, request.value.subscriptionId))
        return { ok: true, value: { closed: false } }
      return control(async () => {
        forget(request.value.subscriptionId)
        return run(
          () => port(request.value),
          (value) => validateRuntime('ClientCloseSubscriptionResult', value).ok,
        )
      })
    },
    // The management routes share the ports of the operations a query call names.
    catalogStatus: via(
      'catalogStatus',
      (value) => validateRuntime('ClientCatalogStatusRequest', value),
      catalogStatus && ((request) => catalogStatus(request, request.header)),
    ),
    streamStatus: via(
      'streamStatus',
      (value) => validateRuntime('ClientArtifactStreamStatusRequest', value),
      streamStatus && ((request) => streamStatus(request, request.header)),
    ),
    // ponytail: binary replies (metadata header plus bytes) have no port shape yet, so a valid request
    // is refused like an unported operation; add one with the artifact access backend.
    readRange: via('readRange', (value) => validateClientBinaryRequest('range', value)),
    openStream: via('openStream', (value) => validateClientBinaryRequest('stream', value)),
    download: via('download', (value) => validateRuntime('ArtifactRedeemDownloadRequest', value)),
  }
  const served = Object.keys(handlers) as Served[]

  /** Answers a request for a served route and returns true; any other path is left to the caller. */
  return async (request, response) => {
    const url = request.url ?? ''
    const split = url.indexOf('?')
    const path = split < 0 ? url : url.slice(0, split)
    const query = split < 0 ? '' : url.slice(split + 1)
    const name = path.startsWith(downloadPrefix)
      ? /^[^/]+$/.test(path.slice(downloadPrefix.length))
        ? 'download'
        : undefined
      : served.find((candidate) => routes[candidate].path === path)
    if (!name) return false
    const { method } = routes[name]
    if (request.method !== method) {
      response.writeHead(405, { Allow: method, ...unread(request) }).end()
      return true
    }
    const input = name === 'download' ? download(path, query, request.headers.range) : await read(request)
    send(request, response, input.ok ? await handlers[name](input.value) : input)
    return true
  }
}
