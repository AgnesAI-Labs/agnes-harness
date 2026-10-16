import { createHash } from 'node:crypto'
import {
  type AdapterStreamOptions,
  createProvider,
  NullContractStore,
  WireAdapter,
  type WireEvent,
} from '@agnes/ai'
import { fakeModel } from '@agnes/ai/testkit'
import type { FakeProvider } from '@agnes/core/testkit'
import type { ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'

/** The route and model a side call under test is sent to. */
export const SIDE_TARGET = Object.freeze({ route: 'contract-side', model: 'contract-side-model' })
/** What the fixture adapter answers, and what a `json` side call parses it into. */
export const SIDE_ANSWER = '{"verdict":"yes"}'
export const SIDE_ENDPOINT_HOST = 'models.example.com'

const API = 'contract-payload'
const route: RouteDecl = {
  route: SIDE_TARGET.route,
  api: API,
  baseUrl: `https://${SIDE_ENDPOINT_HOST}/contract`,
  keyless: true,
}
const record: ModelRecord = fakeModel({
  id: SIDE_TARGET.model,
  route: SIDE_TARGET.route,
  api: API,
  baseUrl: route.baseUrl,
  contextWindow: 64_000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
})

export interface SideAdapter {
  /** `answer` replies once; `stall` takes the request, then neither answers nor looks at its signal. */
  mode: 'answer' | 'stall'
  /** Every request that reached the adapter. */
  readonly seen: readonly RequestBody[]
  /** The signal each request was dispatched with, in the order of `seen`. */
  readonly signals: readonly AbortSignal[]
  /** Whether that signal was already aborted when the adapter started to answer (answer mode only). */
  readonly answeredAborted: readonly boolean[]
  /** Settles when the first request has reached the adapter. */
  readonly arrived: Promise<void>
}

/**
 * A payload-only adapter defined for the suite, like a vendor adapter a plugin ships: it reads
 * `request.payload` and nothing else, answers in one piece and reports the vendor's price as billing.
 * A stalled request is the worst case a deadline or a cancellation must still end by itself.
 */
class PayloadOnlyAdapter extends WireAdapter implements SideAdapter {
  readonly id = 'contract-payload-adapter'
  override readonly version = '1.0.0'
  override readonly acceptsPayload = true
  mode: 'answer' | 'stall' = 'answer'
  readonly seen: RequestBody[] = []
  readonly signals: AbortSignal[] = []
  readonly answeredAborted: boolean[] = []
  readonly arrived: Promise<void>
  #arrive!: () => void

  constructor() {
    super()
    this.arrived = new Promise<void>((resolve) => {
      this.#arrive = resolve
    })
  }

  routes(): RouteDecl[] {
    return [route]
  }

  models(): ModelRecord[] {
    return [record]
  }

  async *stream(
    _route: string,
    request: RequestBody,
    options: AdapterStreamOptions,
  ): AsyncIterable<WireEvent> {
    this.seen.push(request)
    this.signals.push(options.signal)
    options.reportSent?.({
      sentHash: createHash('sha256')
        .update(JSON.stringify(request.payload ?? null))
        .digest('hex'),
      transforms: [{ event: 'payload_body', ext: API }],
    })
    options.reportDispatch?.()
    this.#arrive()
    if (this.mode === 'stall') await new Promise<never>(() => undefined)
    this.answeredAborted.push(options.signal.aborted)
    yield { type: 'text_delta', delta: SIDE_ANSWER }
    yield {
      type: 'usage',
      tokens: { input: 120, output: 4, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'estimated',
      billing: { usdMicros: 420, source: 'gateway', subscription: false },
      response: { id: 'contract-1', model: SIDE_TARGET.model },
    }
    yield { type: 'done', reason: 'stop' }
  }
}

/**
 * Serves the side route through the real provider facade, in front of a scripted conversation
 * provider: requests for the side route reach the fixture adapter (and the facade's payload gate,
 * stamping and price rules), every other request keeps its script.
 */
export function addSideRoute(provider: FakeProvider): SideAdapter {
  const adapter = new PayloadOnlyAdapter()
  const side = createProvider({
    adapters: [adapter],
    routes: { primary: { route: SIDE_TARGET.route, model: SIDE_TARGET.model } },
    contract: new NullContractStore(),
    secrets: () => 'unused',
    clock: Date.now,
    pricing: { creditsPerUsd: 100 },
  })
  const conversation = provider.infer.bind(provider)
  provider.models = () => side.models()
  provider.describeRoute = (name, model) => side.describeRoute?.(name, model)
  provider.infer = (request, options) =>
    request.route === SIDE_TARGET.route ? side.infer(request, options) : conversation(request, options)
  return adapter
}
