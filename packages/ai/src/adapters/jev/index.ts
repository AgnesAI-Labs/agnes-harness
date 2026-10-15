import type { ModelAdapterConfig } from '@agnes/extension-api'
import type { ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import { createDeploymentFetch } from '@agnes/system-node/deployment-network'
import { type AdapterStreamOptions, WireAdapter, type WireEvent } from '../../adapter.js'
import { AiSetupError } from '../../errors.js'
import { sha256Hex } from '../../hash.js'
import {
  answersText,
  classifyStatus,
  endpointFor,
  failureEvent,
  generationId,
  JEV_WIRE_API,
  MAX_ERROR_BYTES,
  MAX_RESPONSE_BYTES,
  parseReply,
  parseRetryAfter,
  readCapped,
  readHead,
  readPayload,
  vendorBody,
  WireFailure,
  zeroUsageEvent,
} from './wire.js'

export { JEV_WIRE_API }
/** Recorded with every side call, so a change in what goes on the wire can be told apart in the audit. */
export const JEV_ADAPTER_VERSION = '1.0.0'

type Network = { fetch: typeof globalThis.fetch; close(): Promise<void> }
type RouteState = { decl: RouteDecl; url: URL; models: ModelRecord[]; network: Network }

export type JevAdapterOptions = {
  routes: ModelAdapterConfig['routes']
  /** Replaces the network layer of each route. By default every route gets a deployment pool. */
  network?: (decl: RouteDecl) => Network
  /** The clock `retry-after` dates are measured against. */
  clock?: () => number
}

/**
 * Answers a `{state, questions}` payload with TypeSafe System One, over `POST <baseUrl>/systemone`.
 *
 * It sends exactly one HTTP request per call and never retries: a rate limit comes back as a
 * retryable error carrying the vendor's wait, and the caller decides whether to ask again, as a new
 * call. Redirects are refused so the key cannot be sent anywhere else, a reply is capped at 1 MiB,
 * and no error message quotes the reply, the key or the vendor's account fields.
 */
export class JevAdapter extends WireAdapter {
  override readonly version = JEV_ADAPTER_VERSION
  override readonly acceptsPayload = true
  readonly id = JEV_WIRE_API
  readonly #routes = new Map<string, RouteState>()
  readonly #lifetime = new AbortController()
  readonly #clock: () => number
  #closing: Promise<void> | undefined

  constructor(opts: JevAdapterOptions) {
    super()
    this.#clock = opts.clock ?? Date.now
    const planned = new Map<string, Omit<RouteState, 'network'>>()
    for (const route of opts.routes) {
      const { models, keyless: _keyless, ...decl } = route
      const fail = (code: ConstructorParameters<typeof AiSetupError>[0], reason: string) =>
        new AiSetupError(code, { route: decl.route, reason })
      if (decl.api !== JEV_WIRE_API) throw fail('NO_ADAPTER', 'the route is for another api')
      const url = endpointFor(decl.baseUrl)
      if (typeof url === 'string') throw fail('INVALID_BASE_URL', url)
      if (planned.has(decl.route)) throw fail('DUPLICATE_ROUTE', 'the route is declared twice')
      // A contract prefix would be written into `system`, which this vendor has no place for.
      if (models.some((m) => m.route !== decl.route || m.api !== JEV_WIRE_API || m.contract_id !== null))
        throw fail('CONTRACT_MISMATCH', 'a model does not belong to this route or names a contract')
      planned.set(decl.route, { decl: structuredClone(decl), url, models: structuredClone(models) })
    }
    const opened: Network[] = []
    try {
      for (const [name, route] of planned) {
        const network = opts.network?.(route.decl) ?? createDeploymentFetch(route.decl.networkTimeouts)
        opened.push(network)
        this.#routes.set(name, { ...route, network })
      }
    } catch (error) {
      for (const network of opened) void network.close().catch(() => undefined)
      throw error
    }
  }

  routes(): RouteDecl[] {
    return [...this.#routes.values()].map((r) => structuredClone(r.decl))
  }

  models(route: string): ModelRecord[] {
    return structuredClone(this.#routes.get(route)?.models ?? [])
  }

  async *stream(route: string, req: RequestBody, opts: AdapterStreamOptions): AsyncIterable<WireEvent> {
    yield* await this.#exchange(route, req, opts)
  }

  /** Ends calls in flight, then closes each route's connection pool. Safe to call again. */
  dispose(): Promise<void> {
    this.#closing ??= (async () => {
      this.#lifetime.abort()
      const routes = [...this.#routes.values()]
      for (const r of routes) this.bindCredential(r.decl.route, undefined)
      await Promise.allSettled(routes.map((r) => r.network.close()))
    })()
    return this.#closing
  }

  async #exchange(route: string, req: RequestBody, opts: AdapterStreamOptions): Promise<WireEvent[]> {
    const state = this.#lifetime.signal.aborted ? undefined : this.#routes.get(route)
    if (!state) return [failureEvent('NO_ADAPTER', false)]
    const payload = readPayload(req)
    if (typeof payload === 'string') return [failureEvent('CONTRACT_MISMATCH', false, { word: payload })]
    const key = this.credentialFor(route)
    if (key === undefined) return [failureEvent('AUTH', false, { word: 'no_credential' })]

    // One limit for the whole call: the reply is one small body, so the first byte arrives about
    // when the last does and the two caller limits come to the same thing.
    const timeout = AbortSignal.timeout(Math.min(opts.timeoutMs.firstToken, opts.timeoutMs.total))
    const signal = AbortSignal.any([opts.signal, timeout, this.#lifetime.signal])
    const interrupted = (): WireEvent =>
      opts.signal.aborted || this.#lifetime.signal.aborted
        ? failureEvent('ABORTED', false)
        : timeout.aborted
          ? failureEvent('TIMEOUT', true)
          : failureEvent('TRANSPORT', true)
    if (signal.aborted) return [interrupted()]

    const body = vendorBody(req.model, payload)
    opts.reportSent?.({
      sentHash: sha256Hex(body),
      transforms: [{ event: 'payload_body', ext: JEV_WIRE_API }],
    })
    try {
      await opts.reportRequest?.(JSON.parse(body))
    } catch {
      /* Request capture is passive and never decides whether to send. */
    }
    opts.reportDispatch?.()
    let response: Response
    try {
      response = await state.network.fetch(state.url.href, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        redirect: 'error',
        signal,
      })
    } catch {
      return [interrupted()]
    }

    const { status } = response
    const requestId = generationId(response.headers)
    if (status < 200 || status >= 300) {
      const cause = classifyStatus(status, await readHead(response, MAX_ERROR_BYTES, signal))
      const retryAfterMs =
        cause.code === 'RATE_LIMIT'
          ? parseRetryAfter(response.headers.get('retry-after'), this.#clock())
          : undefined
      const failure = failureEvent(cause.code, cause.retryable, {
        status,
        word: cause.word,
        retryAfterMs,
        requestId,
      })
      return cause.zeroUsage ? [zeroUsageEvent(status, requestId), failure] : [failure]
    }
    try {
      const text = await readCapped(response, MAX_RESPONSE_BYTES, signal)
      if (signal.aborted) return [interrupted()]
      const reply = parseReply(text)
      const id = reply.id ?? requestId
      return [
        { type: 'text_delta', delta: answersText(reply.answers) },
        {
          type: 'usage',
          tokens: { input: reply.inputTokens, output: reply.outputTokens, cacheRead: 0, cacheWrite: 0 },
          // Credits are the facade's to work out, from the vendor's dollars or the catalogue price.
          creditSource: 'estimated',
          ...(reply.usdMicros === undefined
            ? {}
            : { billing: { usdMicros: reply.usdMicros, source: 'gateway', subscription: false } }),
          response: { status, ...(id === undefined ? {} : { id }), model: reply.model },
        },
        { type: 'done', reason: 'stop' },
      ]
    } catch (error) {
      return [error instanceof WireFailure ? failureEvent(error.code, false) : interrupted()]
    }
  }
}
