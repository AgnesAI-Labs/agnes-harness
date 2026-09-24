import type { ContractStamp, InferenceEvent, ModelRecord, Provider, RequestBody } from '@agnes/protocol'
import { PARSER_VERSION } from '../src/decode/rules/index.js'
import { toolSchemaHash } from '../src/stamp.js'
import { fakeModel } from './fake-adapter.js'

/** A complete request, so a test states only the field its case is about. */
export function fakeRequest(over: Partial<RequestBody> = {}): RequestBody {
  return {
    kind: 'inference',
    sessionKey: 'agnes:t:a:cli:dm:x',
    slot: 'primary',
    route: 'faux',
    model: 'faux-1',
    contractId: null,
    derivedHash: '0'.repeat(64),
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    ...over,
  }
}

/**
 * The stamp a faux run opens with. It is derived from the request rather than being a constant, so
 * a test asserting that a stamp followed the request is asserting on something real, and two runs
 * of the same request still stamp identically.
 */
export function stampFor(req: RequestBody, parserVersion = PARSER_VERSION): ContractStamp {
  return {
    prompt_prefix_hash: null,
    tool_schema_hash: toolSchemaHash(req.tools),
    parser_version: parserVersion,
    contract_id: req.contractId,
    model: { route: req.route, id: req.model },
    derived_hash: req.derivedHash,
    sent_hash: req.derivedHash,
    transforms: [],
  }
}

type Script = InferenceEvent[] | ((req: RequestBody, n: number) => InferenceEvent[])

/**
 * A Provider that answers from a written script instead of a model. It exists so that tests above
 * this package — a kernel replaying a crash, a channel rendering a turn — can pin behaviour against
 * an exact event sequence, including sequences a real model would only produce occasionally.
 *
 * Its guarantees match the real facade where a caller could otherwise write a test that passes
 * against the faux and fails against the real one: `sent` opens every run, nothing follows a
 * terminal event, and an abort ends the run as `error{ABORTED}`.
 */
export class ScriptedProvider implements Provider {
  readonly calls: RequestBody[] = []
  private readonly modelList: ModelRecord[]

  constructor(
    private readonly cfg: {
      models?: ModelRecord[]
      scripts: Script[]
      onExhausted?: 'repeat-last' | 'error'
      parserVersion?: string
    },
  ) {
    this.modelList = cfg.models ?? [fakeModel({ id: 'faux-1', route: 'faux' })]
  }

  models(): ModelRecord[] {
    return this.modelList
  }

  async *infer(
    req: RequestBody,
    opts: { signal: AbortSignal; toolNames: string[] },
  ): AsyncIterable<InferenceEvent> {
    const n = this.calls.length
    this.calls.push(req)
    let script = this.cfg.scripts[n]
    if (!script) {
      // Running past the end is either "keep answering the same way" or "this run should not have
      // happened". Which one is a property of the test, so the test says.
      if ((this.cfg.onExhausted ?? 'repeat-last') === 'error') {
        yield { type: 'sent', stamp: stampFor(req, this.cfg.parserVersion) }
        yield {
          type: 'error',
          reason: 'error',
          code: 'TRANSPORT',
          message: 'script exhausted',
          retryable: false,
        }
        return
      }
      script = this.cfg.scripts.at(-1) ?? []
    }
    const events = typeof script === 'function' ? script(req, n) : script
    if (events[0]?.type !== 'sent') yield { type: 'sent', stamp: stampFor(req, this.cfg.parserVersion) }
    for (const e of events) {
      if (opts.signal.aborted) {
        yield { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false }
        return
      }
      yield e
      if (e.type === 'done' || e.type === 'error') return
    }
  }
}

/**
 * Wraps any Provider and keeps what went in and what came out, so a run against a real route can be
 * written down once and replayed as a fixture afterwards. It changes nothing on the way through.
 */
export class RecordingProvider implements Provider {
  readonly records: Array<{ req: RequestBody; events: InferenceEvent[] }> = []
  constructor(private readonly inner: Provider) {}

  models(): ModelRecord[] {
    return this.inner.models()
  }

  async *infer(
    req: RequestBody,
    opts: { signal: AbortSignal; toolNames: string[] },
  ): AsyncIterable<InferenceEvent> {
    // The record is registered before the first event, so a run abandoned or aborted mid-stream is
    // still visible afterwards as the partial run it was.
    const rec = { req, events: [] as InferenceEvent[] }
    this.records.push(rec)
    for await (const e of this.inner.infer(req, opts)) {
      rec.events.push(e)
      yield e
    }
  }

  /** One JSON line per run, in the order they happened: the fixture format a replay reads back. */
  dump(): string {
    return `${this.records.map((r) => JSON.stringify(r)).join('\n')}\n`
  }
}
