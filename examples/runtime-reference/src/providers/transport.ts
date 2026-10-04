// A second, independent server for the runtime client wire: HTTP routes plus polled subscriptions,
// written against the generated route table and the protocol validators alone. Each JSON route is
// admitted, bounded, parsed and validated before its owner sees it; an owner reply leaves only in its
// registered shape; an operation the owner does not serve is refused as not supported.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Outcome } from '@agnes/extension-api/runtime'
import {
  type BuildIdentity,
  type ConformanceHarness,
  providerFileForContract,
} from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeClientTransportPolicy,
  RuntimeClientTransportWire,
  RuntimeErrorDetails,
  runtimeErrorHttpStatus,
  validateClientBootstrap,
  validateClientCatalogPage,
  validateClientCommandRequest,
  validateClientQueryRequest,
  validateClientReply,
  validateRuntime,
  validateRuntimeErrorDetail,
} from '@agnes/protocol/runtime'
import {
  registerTransportContract,
  type TransportAdmission,
  type TransportBacking,
  type TransportConformanceBinding,
  type TransportServer,
} from '../../../../packages/extension-api/testkit/runtime/contracts/transport.js'

const { routes, jsonMime } = RuntimeClientTransportWire

const fail = (detail: keyof typeof RuntimeErrorDetails, message: string): Outcome<never> => ({
  ok: false,
  error: {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: randomUUID(),
  },
})
const invalid = () => fail('invalid_request', 'invalid runtime client request')
const unsupported = () => fail('operation_not_supported', 'the owner does not serve this operation')

type Route = (body: unknown) => Promise<Outcome<unknown>>

/** A route that validates its request, asks the owner and lets the reply leave only in its registered
 * shape; a throwing owner or a reply of any other shape becomes an internal failure. */
const route =
  <I>(
    validate: (body: unknown) => Wire.ValidationResult<I>,
    answer: (request: I) => Promise<Outcome<unknown>>,
    valid: (value: unknown, request: I) => boolean,
  ): Route =>
  async (body) => {
    const request = validate(body)
    if (!request.ok) return invalid()
    try {
      const outcome = await answer(request.value)
      if (outcome.ok ? valid(outcome.value, request.value) : validateRuntimeErrorDetail(outcome.error).ok)
        return outcome
    } catch {
      // Falls through to the internal failure below.
    }
    return fail('internal_error', 'the owner answered outside the registered shape')
  }

/** The JSON routes this server answers; the binary artifact routes and the push socket are not served. */
function jsonRoutes(owner: TransportBacking): Record<string, Route> {
  const serves = (operation: Wire.ClientJsonOperation) => owner.operations.includes(operation)
  /** A JSON call reaches the owner of its operation; the reply carries the call's own header. */
  const call = async ({ header, call }: Wire.ClientQueryRequest | Wire.ClientCommandRequest) => {
    if (!serves(call.operation)) return unsupported()
    const outcome = await owner.call(call.operation, call.input, header)
    return outcome.ok
      ? { ok: true as const, value: { header, reply: { operation: call.operation, value: outcome.value } } }
      : outcome
  }
  /** A management route answers through the query operation of the same name. */
  const managed = (
    operation: 'transport.catalogStatus' | 'transport.streamStatus',
    request: { readonly header: Wire.ClientCallHeader },
  ) => (serves(operation) ? owner.call(operation, request, request.header) : Promise.resolve(unsupported()))
  return {
    [routes.bootstrap.path]: route(
      (body) => validateRuntime('ClientHello', body),
      (hello) => owner.bootstrap(hello),
      (value) => validateClientBootstrap(value).ok,
    ),
    [routes.catalogPage.path]: route(
      (body) => validateRuntime('ClientCatalogPageRequest', body),
      (request) => owner.catalogPage(request),
      (value, request) => validateClientCatalogPage(value, request.limit).ok,
    ),
    [routes.clientQuery.path]: route(
      validateClientQueryRequest,
      call,
      (value, request) => validateClientReply(request, value).ok,
    ),
    [routes.clientCommand.path]: route(
      validateClientCommandRequest,
      call,
      (value, request) => validateClientReply(request, value).ok,
    ),
    [routes.subscribe.path]: route(
      (body) => validateRuntime('ClientSubscribeRequest', body),
      (request) => owner.subscribe(request),
      (value) => validateRuntime('ClientSubscribeResult', value).ok,
    ),
    [routes.readSubscription.path]: route(
      (body) => validateRuntime('ClientReadSubscriptionRequest', body),
      (request) => owner.readSubscription(request),
      (value) => validateRuntime('ClientReadSubscriptionResult', value).ok,
    ),
    [routes.closeSubscription.path]: route(
      (body) => validateRuntime('ClientCloseSubscriptionRequest', body),
      (request) => owner.closeSubscription(request),
      (value) => validateRuntime('ClientCloseSubscriptionResult', value).ok,
    ),
    [routes.catalogStatus.path]: route(
      (body) => validateRuntime('ClientCatalogStatusRequest', body),
      (request) => managed('transport.catalogStatus', request),
      (value) => validateRuntime('ClientCatalogStatusResult', value).ok,
    ),
    [routes.streamStatus.path]: route(
      (body) => validateRuntime('ClientArtifactStreamStatusRequest', body),
      (request) => managed('transport.streamStatus', request),
      (value) => validateRuntime('ClientArtifactStreamStatusResult', value).ok,
    ),
  }
}

/** The JSON body within the wire limit; bytes past it are read and dropped, never kept. */
async function readJson(request: IncomingMessage): Promise<Outcome<unknown>> {
  const type = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (type !== jsonMime) return invalid()
  const limit = RuntimeClientTransportPolicy.maxJsonBytes
  const tooLarge = () => fail('rpc_json_bytes', 'the request exceeds the JSON limit')
  if (Number(request.headers['content-length']) > limit) return tooLarge()
  const kept: Buffer[] = []
  let size = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size <= limit) kept.push(chunk)
  }
  if (size > limit) return tooLarge()
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(kept))),
    }
  } catch {
    return invalid()
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest()
const sameSecret = (given: string | undefined, expected: string) =>
  timingSafeEqual(digest(given ?? ''), digest(expected))

function reply(request: IncomingMessage, response: ServerResponse, outcome: Outcome<unknown>): void {
  response.writeHead(outcome.ok ? 200 : runtimeErrorHttpStatus(outcome.error), {
    'Content-Type': `${jsonMime}; charset=utf-8`,
    'Cache-Control': 'no-store',
    // A body left unread, such as a declared oversized one, ends the connection with this reply.
    ...(request.complete ? {} : { Connection: 'close' }),
  })
  response.end(
    JSON.stringify(outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error }),
  )
}

/** Serves the runtime client JSON routes over `owner` on a loopback port, admitting only `admission`. */
export async function startReferenceTransport(
  owner: TransportBacking,
  admission: TransportAdmission,
): Promise<TransportServer> {
  const handlers = jsonRoutes(owner)
  let host = ''
  const admitted = (request: IncomingMessage) =>
    admission.kind === 'bearer'
      ? sameSecret(request.headers.authorization, `Bearer ${admission.credential}`)
      : request.headers.origin === admission.origin && request.headers.host === host
  const serve = async (request: IncomingMessage, response: ServerResponse) => {
    if (!admitted(request))
      return reply(
        request,
        response,
        admission.kind === 'bearer'
          ? fail('authentication_required', 'the request carries no admitted credential')
          : fail('permission_denied', 'the request comes from another origin or host'),
      )
    const path = (request.url ?? '').split('?')[0] ?? ''
    const handler = Object.hasOwn(handlers, path) ? handlers[path] : undefined
    if (handler === undefined) return reply(request, response, fail('not_found', 'no such route'))
    // Every JSON route of the generated table is a POST.
    if (request.method !== 'POST')
      return void response
        .writeHead(405, { Allow: 'POST', ...(request.complete ? {} : { Connection: 'close' }) })
        .end()
    const body = await readJson(request)
    reply(request, response, body.ok ? await handler(body.value) : body)
  }
  const server = createServer((request, response) => {
    serve(request, response).catch(() => response.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
  let closing: Promise<void> | undefined
  return {
    baseUrl: `http://${host}`,
    close: () =>
      (closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })),
  }
}

const sha256 = (...urls: URL[]) =>
  urls.reduce((hash, url) => hash.update(readFileSync(url)), createHash('sha256')).digest('hex')

const build: BuildIdentity = {
  codeSha: 'reference-code',
  buildDigest: 'reference-build',
  lockDigest: 'reference-lock',
  specVersion: 'reference-spec',
  sdkVersion: 'reference-sdk',
  sdkDigest: 'reference-sdk-digest',
  platform: 'reference-platform',
}

/**
 * Registers the six transport cases for the reference server, reported under `providerId` (the runner
 * passes the name it was asked for, such as `reference`). This package carries no runtime client, so the
 * caller supplies `client`, the same one the default server is judged with.
 */
export function bindTransportContract(
  harness: ConformanceHarness,
  command: string,
  options: Readonly<{ providerId?: string } & Pick<TransportConformanceBinding, 'client'>>,
): void {
  registerTransportContract(harness, {
    providerId: options.providerId ?? 'reference.transport',
    recipe: providerFileForContract('agh.transport'),
    command,
    build,
    providerDigest: sha256(new URL('./transport.ts', import.meta.url)),
    configDigest: canonicalJsonDigest({}),
    releaseSetDigest: sha256(new URL('../../package.json', import.meta.url)),
    admissions: ['bearer', 'page-origin'],
    start: startReferenceTransport,
    client: options.client,
  })
}
