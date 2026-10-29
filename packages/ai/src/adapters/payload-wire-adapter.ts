// The skeleton both payload-only adapters (TypeSafe System One, openai-audio) share: route planning and
// validation, one deployment pool per route, a lifetime that ends calls in flight, and the single
// request each call makes (limits, reports, dispatch, status handling). A subclass supplies only what
// differs: where a route's calls go, the payload it accepts, the request that payload becomes, how a
// refused status is classified and how a successful reply is read.
import type { ModelAdapterConfig } from '@agnes/extension-api'
import type { ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import { createDeploymentFetch } from '@agnes/system-node/deployment-network'
import { type AdapterStreamOptions, WireAdapter, type WireEvent } from '../adapter.js'
import { AiSetupError } from '../errors.js'
import { sha256Hex } from '../hash.js'
import {
  type Classified,
  failureEvent,
  parseRetryAfter,
  WireFailure,
  zeroUsageEvent,
} from './payload-wire.js'

type Network = { fetch: typeof globalThis.fetch; close(): Promise<void> }
type RouteState = { decl: RouteDecl; url: URL; models: ModelRecord[]; network: Network }

export type PayloadAdapterOptions = {
  routes: ModelAdapterConfig['routes']
  /** Replaces the network layer of each route. By default every route gets a deployment pool. */
  network?: (decl: RouteDecl) => Network
  /** The clock `retry-after` dates are measured against. */
  clock?: () => number
}

/** What a payload becomes on the wire. */
export type PayloadRequest = {
  url: string
  headers: Record<string, string>
  body: string | Uint8Array<ArrayBuffer>
  /** What the request-capture hook may see: never the credential, and no more than the vendor is sent. */
  report: unknown
}

export type PayloadAdapterSetup = {
  /** The wire api this adapter serves; it is also the adapter id and the prefix of every message. */
  api: string
  /** Where a route's calls go (the URL handed to `prepare`), or the reason the base URL cannot be used. */
  target(baseUrl: string): URL | string
  /** How long an idle pooled connection is kept; the pool's own default when absent. */
  keepAliveMs?: number
}

export abstract class PayloadWireAdapter<Payload> extends WireAdapter {
  override readonly acceptsPayload = true
  readonly id: string
  readonly #routes = new Map<string, RouteState>()
  readonly #lifetime = new AbortController()
  readonly #clock: () => number
  #closing: Promise<void> | undefined

  protected constructor(setup: PayloadAdapterSetup, opts: PayloadAdapterOptions) {
    super()
    this.id = setup.api
    this.#clock = opts.clock ?? Date.now
    const planned = new Map<string, Omit<RouteState, 'network'>>()
    for (const route of opts.routes) {
      const { models, keyless: _keyless, ...decl } = route
      const fail = (code: ConstructorParameters<typeof AiSetupError>[0], reason: string) =>
        new AiSetupError(code, { route: decl.route, reason })
      if (decl.api !== setup.api) throw fail('NO_ADAPTER', 'the route is for another api')
      const url = setup.target(decl.baseUrl)
      if (typeof url === 'string') throw fail('INVALID_BASE_URL', url)
      if (planned.has(decl.route)) throw fail('DUPLICATE_ROUTE', 'the route is declared twice')
      // A contract prefix would be written into `system`, which a payload has no place for.
      if (models.some((m) => m.route !== decl.route || m.api !== setup.api || m.contract_id !== null))
        throw fail('CONTRACT_MISMATCH', 'a model does not belong to this route or names a contract')
      planned.set(decl.route, { decl: structuredClone(decl), url, models: structuredClone(models) })
    }
    const opened: Network[] = []
    try {
      for (const [name, route] of planned) {
        const network =
          opts.network?.(route.decl) ??
          createDeploymentFetch({
            ...route.decl.networkTimeouts,
            ...(setup.keepAliveMs === undefined ? {} : { keepAliveTimeoutMs: setup.keepAliveMs }),
          })
        opened.push(network)
        this.#routes.set(name, { ...route, network })
      }
    } catch (error) {
      for (const network of opened) void network.close().catch(() => undefined)
      throw error
    }
  }

  /** The payload a request carries, or why this is not a request the vendor can answer. */
  protected abstract readPayload(req: RequestBody): Payload | string
  /** The request a payload becomes. `url` is the route's target as `target` returned it. */
  protected abstract prepare(url: URL, req: RequestBody, payload: Payload): PayloadRequest
  /** What a refused status means. It may read the response body; it must not leave one unread and open. */
  protected abstract classify(response: Response, signal: AbortSignal): Promise<Classified>
  /** The vendor's id for a call, when a header holds something safe to record. */
  protected abstract requestIdOf(headers: Headers): string | undefined
  /**
   * The events of a successful reply. A reply that cannot be used is thrown as a `WireFailure`, or
   * answered with the events the subclass wants; an abort mid-read may throw anything.
   */
  protected abstract read(
    response: Response,
    payload: Payload,
    ctx: { req: RequestBody; signal: AbortSignal; requestId: string | undefined },
  ): Promise<WireEvent[]>

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
    if (!state) return [failureEvent(this.id, 'NO_ADAPTER', false)]
    const payload = this.readPayload(req)
    if (typeof payload === 'string')
      return [failureEvent(this.id, 'CONTRACT_MISMATCH', false, { word: payload })]
    const key = this.credentialFor(route)
    if (key === undefined) return [failureEvent(this.id, 'AUTH', false, { word: 'no_credential' })]

    // One limit for the whole call: the reply is one body, so the first byte arrives about when the
    // last does and the two caller limits come to the same thing.
    const timeout = AbortSignal.timeout(Math.min(opts.timeoutMs.firstToken, opts.timeoutMs.total))
    const signal = AbortSignal.any([opts.signal, timeout, this.#lifetime.signal])
    const interrupted = (): WireEvent =>
      opts.signal.aborted || this.#lifetime.signal.aborted
        ? failureEvent(this.id, 'ABORTED', false)
        : timeout.aborted
          ? failureEvent(this.id, 'TIMEOUT', true)
          : failureEvent(this.id, 'TRANSPORT', true)
    if (signal.aborted) return [interrupted()]

    const wire = this.prepare(state.url, req, payload)
    opts.reportSent?.({
      sentHash: sha256Hex(wire.body),
      transforms: [{ event: 'payload_body', ext: this.id }],
    })
    try {
      await opts.reportRequest?.(wire.report)
    } catch {
      /* Request capture is passive and never decides whether to send. */
    }
    // The capture hook can take a while; a call that ended meanwhile is not dispatched or reported.
    if (signal.aborted) return [interrupted()]
    opts.reportDispatch?.()
    let response: Response
    try {
      response = await state.network.fetch(wire.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, ...wire.headers },
        body: wire.body,
        redirect: 'error',
        signal,
      })
    } catch {
      return [interrupted()]
    }

    const { status } = response
    const requestId = this.requestIdOf(response.headers)
    if (status < 200 || status >= 300) {
      const cause = await this.classify(response, signal)
      const retryAfterMs =
        cause.code === 'RATE_LIMIT'
          ? parseRetryAfter(response.headers.get('retry-after'), this.#clock())
          : undefined
      const failure = failureEvent(this.id, cause.code, cause.retryable, {
        status,
        word: cause.word,
        retryAfterMs,
        requestId,
      })
      return cause.zeroUsage ? [zeroUsageEvent(status, requestId), failure] : [failure]
    }
    try {
      const events = await this.read(response, payload, { req, signal, requestId })
      return signal.aborted ? [interrupted()] : events
    } catch (error) {
      return [
        signal.aborted || !(error instanceof WireFailure)
          ? interrupted()
          : failureEvent(this.id, error.code, false),
      ]
    }
  }
}
