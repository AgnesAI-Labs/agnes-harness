import type {
  AiErrorCode,
  DecisionModelRecord,
  DecisionWireAnswer,
  DecisionWireRequest,
  RouteDecl,
} from '@agnes/protocol'
import {
  DecisionAdapter,
  type DecisionAdapterAnswer,
  DecisionAdapterError,
  type DecisionUsage,
} from '../src/adapter.js'

export const FAKE_DECISION_ROUTE = 'fake-decision'
export const FAKE_DECISION_MODEL = 'fake-decision-1'

export type FakeDecisionStep =
  | { answers: Record<string, DecisionWireAnswer>; model?: string; usage?: DecisionUsage }
  | { hang: true }
  | { http: 401 | 422 | 429 | 529; retryAfter?: string }
  | { raw: unknown }
export type FakeDecisionScript = { route?: string; model?: string; steps: FakeDecisionStep[] }

const HTTP_CODE: Record<401 | 422 | 429 | 529, AiErrorCode> = {
  401: 'AUTH',
  422: 'CONTRACT_MISMATCH',
  429: 'RATE_LIMIT',
  529: 'RATE_LIMIT',
}

/** A complete decision record, priced like Jev, so a test states only what it is about. */
export function fakeDecisionModel(over: Partial<DecisionModelRecord> = {}): DecisionModelRecord {
  const route = over.route ?? FAKE_DECISION_ROUTE
  const id = over.id ?? FAKE_DECISION_MODEL
  return {
    id,
    name: id,
    api: 'fake-decision',
    route,
    baseUrl: 'fake://decision',
    kind: 'decision',
    contextWindow: 64000,
    cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...over,
  }
}

/** The route declaration createProvider's `decision.routes` needs for a fake. */
export function fakeDecisionRouteDecl(route = FAKE_DECISION_ROUTE, model = FAKE_DECISION_MODEL): RouteDecl {
  return {
    route,
    api: 'fake-decision',
    baseUrl: 'fake://decision',
    models: [fakeDecisionModel({ route, id: model })],
  }
}

/**
 * A decision adapter that talks to nothing. Each call consumes the next scripted step: an answer,
 * a hang that ends only when the call is aborted, a vendor HTTP failure as the facade would see it
 * after the real adapter gave up, or a raw value returned untouched so a caller's validator can be
 * pointed at shapes no well-behaved vendor sends. It never retries and never reads a credential.
 */
export class FakeDecisionAdapter extends DecisionAdapter {
  readonly id = 'fake-decision'
  readonly calls: Array<{ route: string; req: DecisionWireRequest }> = []
  readonly #route: string
  readonly #model: DecisionModelRecord
  readonly #steps: FakeDecisionStep[]
  #next = 0

  constructor(script: FakeDecisionScript) {
    super()
    this.#route = script.route ?? FAKE_DECISION_ROUTE
    this.#model = fakeDecisionModel({ route: this.#route, id: script.model ?? FAKE_DECISION_MODEL })
    this.#steps = [...script.steps]
  }

  get remaining(): number {
    return this.#steps.length - this.#next
  }

  routes(): readonly string[] {
    return [this.#route]
  }

  models(route: string): readonly DecisionModelRecord[] {
    return route === this.#route ? [this.#model] : []
  }

  credentialDecls() {
    return [{ route: this.#route }]
  }

  decide(
    route: string,
    req: DecisionWireRequest,
    opts: { signal: AbortSignal },
  ): Promise<DecisionAdapterAnswer> {
    this.calls.push({ route, req: structuredClone(req) })
    const step = this.#steps[this.#next]
    this.#next += 1
    if (!step) return Promise.reject(new Error('FakeDecisionAdapter: script exhausted'))
    if ('hang' in step)
      return new Promise((_, reject) => {
        const fail = () => reject(new DecisionAdapterError('ABORTED'))
        if (opts.signal.aborted) fail()
        else opts.signal.addEventListener('abort', fail, { once: true })
      })
    if ('http' in step)
      return Promise.reject(new DecisionAdapterError(HTTP_CODE[step.http], step.http, step.retryAfter))
    if ('raw' in step) return Promise.resolve(step.raw as DecisionAdapterAnswer)
    return Promise.resolve({
      answers: structuredClone(step.answers),
      model: step.model ?? this.#model.id,
      usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
    })
  }
}
