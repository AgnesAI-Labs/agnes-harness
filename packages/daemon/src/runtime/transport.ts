// The daemon end of the runtime client wire over HTTP. Every route of the generated table except the
// push socket is matched here by method and path; its request is bounded, parsed and validated
// before the injected port for its operation sees it, and a route or operation without a port
// answers the typed `operation_not_supported` refusal. The listener authenticates each request
// before it reaches this module, which grants no authority of its own.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type * as Wire from '@agnes/protocol/runtime'
import {
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

const failure = (detailCode: string, code: Wire.RuntimeError['code'], message: string): Outcome<never> => ({
  ok: false,
  error: { code, detailCode, message, retryAdvice: { kind: 'never' }, diagnosticId: randomUUID() },
})
const invalid = () => failure('invalid_request', 'invalid_input', 'invalid runtime client request')
const tooLarge = () => failure('rpc_json_bytes', 'quota', 'runtime client request exceeds the JSON limit')
const unsupported = () =>
  failure('operation_not_supported', 'incompatible', 'runtime client operation is not wired to a backend')
const broken = () => failure('internal_error', 'internal', 'runtime client backend failed')

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

export function runtimeClientRoutes(ports: RuntimeClientPorts): RuntimeClientRoutes {
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
      return request.ok ? dispatch(request.value) : invalid()
    },
    catalogPage: via(
      'catalogPage',
      (value) => validateRuntime('ClientCatalogPageRequest', value),
      ports.catalogPage,
    ),
    subscribe: via('subscribe', (value) => validateRuntime('ClientSubscribeRequest', value), ports.subscribe),
    readSubscription: via(
      'readSubscription',
      (value) => validateRuntime('ClientReadSubscriptionRequest', value),
      ports.readSubscription,
    ),
    closeSubscription: via(
      'closeSubscription',
      (value) => validateRuntime('ClientCloseSubscriptionRequest', value),
      ports.closeSubscription,
    ),
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
