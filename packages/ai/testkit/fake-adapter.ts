import type { ModelRecord, RequestBody, RouteDecl } from '@agnes/protocol'
import { type AdapterStreamOptions, WireAdapter, type WireEvent } from '../src/adapter.js'
import type { SentReport } from '../src/stamp.js'

/** A complete ModelRecord from an id and a route, so a test states only the fields it cares about. */
export function fakeModel(over: Partial<ModelRecord> & { id: string; route: string }): ModelRecord {
  return {
    name: over.id,
    api: 'openai-completions',
    baseUrl: 'https://fake.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    toolCallFormats: ['native'],
    thinkingReplay: 'native',
    contract_id: null,
    ...over,
  }
}

export type FakeAdapterConfig = {
  id: string
  routes: RouteDecl[]
  models: Record<string, ModelRecord[]>
  reportSent?: SentReport
  script?: (req: RequestBody) => WireEvent[]
}

/**
 * An adapter that talks to nothing. It records the requests it is handed and replays a scripted
 * event list, so tests above it can assert on what reached the wire layer without a network.
 */
export class FakeAdapter extends WireAdapter {
  readonly id: string
  readonly calls: Array<{ route: string; req: RequestBody }> = []

  constructor(private readonly cfg: FakeAdapterConfig) {
    super()
    this.id = cfg.id
  }

  routes(): RouteDecl[] {
    return this.cfg.routes
  }

  models(route: string): ModelRecord[] {
    return this.cfg.models[route] ?? []
  }

  async *stream(route: string, req: RequestBody, opts: AdapterStreamOptions): AsyncIterable<WireEvent> {
    if (this.cfg.reportSent) opts.reportSent?.(this.cfg.reportSent)
    this.calls.push({ route, req })
    const events = this.cfg.script?.(req) ?? [
      { type: 'text_delta', delta: 'ok' },
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
      },
      { type: 'done', reason: 'stop' },
    ]
    for (const e of events) {
      if (opts.signal.aborted) {
        yield { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false }
        return
      }
      yield e
    }
  }

  /** Test-only window onto the protected credential store, to assert what assembly bound. */
  seenCredential(route: string): string | undefined {
    return this.credentialFor(route)
  }
}
