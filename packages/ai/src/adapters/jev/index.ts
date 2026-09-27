import type { DecisionModelRecord, DecisionWireRequest, RouteDecl } from '@agnes/protocol'
import {
  type CredentialDecl,
  DecisionAdapter,
  type DecisionAdapterAnswer,
  DecisionAdapterError,
} from '../../adapter.js'
import { isDecisionModelRecord } from '../../decision-registry.js'
import { AiSetupError } from '../../errors.js'
import { retryDelayMs, statusAction } from './errors.js'
import {
  endpointFor,
  JEV_APIS,
  type JevApi,
  MAX_RESPONSE_BYTES,
  parseResponse,
  readCapped,
  requestBody,
} from './wire.js'

export type JevAdapterOptions = {
  routes: readonly RouteDecl[]
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  clock?: () => number
  log?: { warn(message: string, detail?: Record<string, unknown>): void }
  /** Total attempts per call, the first included. */
  maxAttempts?: number
}

type JevRoute = {
  route: string
  api: JevApi
  url: URL
  credentialRef?: string
  models: DecisionModelRecord[]
}

/** The `details` field of a 422 body when there is one, otherwise the body text itself. */
function rejectionDetails(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object' && 'details' in parsed)
      return (parsed as { details: unknown }).details
  } catch {
    // Not JSON: the raw text is what there is to log.
  }
  return text
}

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DecisionAdapterError('ABORTED'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DecisionAdapterError('ABORTED'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * TypeSafe's Jev over its documented HTTP API, directly or through OpenRouter's reseller route. It
 * speaks plain `fetch` rather than the vendor SDK: one endpoint does not justify a new dependency.
 *
 * Retries are for 429 and 529 only, and never past the call's own time limit: a wait that would
 * outlast it is not started. Redirects are refused, so a credential cannot follow one elsewhere.
 */
export class JevDecisionAdapter extends DecisionAdapter {
  static readonly APIS: ReadonlySet<string> = new Set<string>(JEV_APIS)
  readonly id = 'jev'
  readonly #routes = new Map<string, JevRoute>()
  readonly #fetch: typeof globalThis.fetch
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly #clock: () => number
  readonly #log: JevAdapterOptions['log']
  readonly #maxAttempts: number
  readonly #warned = new Set<string>()

  constructor(opts: JevAdapterOptions) {
    super()
    for (const decl of opts.routes) {
      if (!JevDecisionAdapter.APIS.has(decl.api))
        throw new AiSetupError('ADAPTER_KIND', { route: decl.route, api: decl.api })
      let url: URL
      try {
        url = endpointFor(decl.api as JevApi, decl.baseUrl)
      } catch {
        throw new AiSetupError('INVALID_BASE_URL', { route: decl.route })
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new AiSetupError('INVALID_BASE_URL', { route: decl.route })
      if (this.#routes.has(decl.route))
        throw new AiSetupError('DUPLICATE_ROUTE', { route: decl.route, adapters: [this.id] })
      const models = (decl.models ?? []).map((m) => {
        if (!isDecisionModelRecord(m) || m.route !== decl.route)
          throw new AiSetupError('ADAPTER_KIND', { route: decl.route, model: String(m.id) })
        return m
      })
      this.#routes.set(decl.route, {
        route: decl.route,
        api: decl.api as JevApi,
        url,
        ...(decl.credentialRef ? { credentialRef: decl.credentialRef } : {}),
        models,
      })
    }
    this.#fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#sleep = opts.sleep ?? sleepUnlessAborted
    this.#clock = opts.clock ?? Date.now
    this.#log = opts.log
    this.#maxAttempts = opts.maxAttempts ?? 4
  }

  routes(): readonly string[] {
    return [...this.#routes.keys()]
  }

  models(route: string): readonly DecisionModelRecord[] {
    return this.#routes.get(route)?.models ?? []
  }

  credentialDecls(): readonly CredentialDecl[] {
    return [...this.#routes.values()].map((r) => ({
      route: r.route,
      ...(r.credentialRef ? { credentialRef: r.credentialRef } : {}),
    }))
  }

  async decide(
    route: string,
    req: DecisionWireRequest,
    opts: { signal: AbortSignal },
  ): Promise<DecisionAdapterAnswer> {
    const r = this.#routes.get(route)
    if (!r) throw new DecisionAdapterError('NO_ADAPTER')
    const credential = this.credentialFor(route)
    if (credential === undefined) throw new DecisionAdapterError('AUTH')
    const deadline = this.#clock() + req.timeoutMs
    const body = requestBody(req)
    for (let attempt = 0; ; attempt += 1) {
      let res: Response
      try {
        res = await this.#fetch(r.url, {
          method: 'POST',
          redirect: 'error',
          signal: opts.signal,
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
        })
      } catch {
        throw new DecisionAdapterError(opts.signal.aborted ? 'ABORTED' : 'TRANSPORT')
      }
      if (res.ok) {
        const answer = parseResponse(await this.#read(res, opts.signal), r.api)
        this.#checkVersion(route, req.model, answer.model)
        return answer
      }
      const action = statusAction(res.status)
      if (action.kind === 'fail') {
        if (res.status === 422) this.#logRejection(route, await this.#read(res, opts.signal).catch(() => ''))
        else await res.body?.cancel().catch(() => undefined)
        throw new DecisionAdapterError(action.code, res.status)
      }
      await res.body?.cancel().catch(() => undefined)
      const wait = retryDelayMs(res.headers.get('retry-after'), attempt, this.#clock())
      if (attempt + 1 >= this.#maxAttempts || wait >= deadline - this.#clock())
        throw new DecisionAdapterError('RATE_LIMIT', res.status)
      await this.#sleep(wait, opts.signal)
    }
  }

  async #read(res: Response, signal: AbortSignal): Promise<string> {
    try {
      return await readCapped(res, MAX_RESPONSE_BYTES)
    } catch (e) {
      if (e instanceof DecisionAdapterError) throw e
      throw new DecisionAdapterError(signal.aborted ? 'ABORTED' : 'TRANSPORT')
    }
  }

  // The vendor's validation details can quote the request, so they go to the host log, bounded, and
  // never into the error the caller sees.
  #logRejection(route: string, text: string): void {
    this.#log?.warn('decision request rejected by the provider', {
      route,
      status: 422,
      details: JSON.stringify(rejectionDetails(text) ?? null).slice(0, 2048),
    })
  }

  // Thresholds are tuned against one version. An answer from another is still returned - refusing
  // it would turn a vendor rollout into an outage - but it is said once per route and version pair.
  #checkVersion(route: string, pinned: string, actual: string): void {
    if (actual === pinned) return
    const key = JSON.stringify([route, pinned, actual])
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    this.#log?.warn('decision answered by a different model version than the route pins', {
      route,
      pinned,
      actual,
    })
  }
}
