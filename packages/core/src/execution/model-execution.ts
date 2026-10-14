import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import type { EffectHandle, EffectOutcome } from '@agnes/core-effects/effects/effect'
import type { CostLedger } from '@agnes/extension-api/seams'
import type { InferenceEvent, RequestBody } from '@agnes/protocol'
import { settleTreeSpend } from '../child/runtime-budget.js'
import type { RequestHeaderData } from '../request/derive.js'
import { runCoreReplacement } from '../step/reentry.js'
import type { OpContext, SessionImpl } from '../step/session.js'
import { estimateTokens } from './model-tokens.js'

type Usage = Extract<InferenceEvent, { type: 'usage' }>
type Failure = Extract<InferenceEvent, { type: 'error' }>

/** Cancellation also covers factory/replacement admission, before an iterator exists. */
function interruptible<T>(work: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let cancelled = false
    const abort = () => {
      cancelled = true
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (cancelled) {
          try {
            late?.(value)
          } catch {
            /* detached replacement cleanup */
          }
        } else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Transport, receipts and spend belong to Core; retry and continuation policy belongs to the Loop. */
export class ModelExecution {
  readonly controller = new AbortController()
  readonly cancellation: AbortSignal
  readonly signal: AbortSignal
  private usage: Usage | undefined
  private error: Failure | undefined
  private text = ''
  private thinking = ''
  private providerIterator: AsyncIterator<InferenceEvent> | undefined
  private providerClosed = false
  private completed = false
  private accounted = false
  private recording: Promise<void> | undefined
  private readonly release: () => void
  private readonly finishReceipt: () => void
  private readonly cancelReceipt = () => {
    this.controller.abort()
    this.closeProvider()
    if (this.accounted) return
    void this.commit(this.rows(this.outcome, this.outcome !== 'ok'), (cur) => cur).catch((error) => {
      if (!(error instanceof CoreError && error.code === 'E_CLOSED'))
        this.s.d.logger.warn('model receipt settlement failed', {
          sessionKey: this.s.key,
          error: String(error),
        })
    })
  }
  private closeProvider(): void {
    if (!this.providerIterator || this.providerClosed) return
    this.providerClosed = true
    try {
      void Promise.resolve(this.providerIterator.return?.()).catch(() => undefined)
    } catch {
      /* provider cleanup cannot hold settlement */
    }
  }

  get settled(): boolean {
    return this.accounted
  }
  private readonly turn
  private readonly op

  constructor(
    private readonly s: SessionImpl,
    private readonly input: {
      wire: RequestBody
      header: RequestHeaderData
      effect: EffectHandle
      headerSeq: Seq
      intentSeq: Seq
      signal: AbortSignal
      context?: OpContext
      publicIterator?: boolean
      turnId: number
      step: number
      memory: SessionImpl['turn']
    },
  ) {
    this.turn = input.memory
    this.op = { turn: input.turnId, step: input.step }
    this.cancellation = AbortSignal.any([input.signal, s.ac.signal])
    this.signal = AbortSignal.any([this.cancellation, this.controller.signal])
    let finish!: () => void
    s.trackEffectReceipt(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    this.finishReceipt = finish
    this.release = s.loopScope.alive ? s.loopScope.own(this.cancelReceipt) : () => undefined
    // A public iterator can be abandoned at yield; Core's phase consumer always drives its finally.
    if (input.publicIterator) this.cancellation.addEventListener('abort', this.cancelReceipt, { once: true })
    if ((input.publicIterator && this.cancellation.aborted) || !s.loopScope.alive) this.cancelReceipt()
  }

  async *stream(): AsyncIterable<InferenceEvent> {
    const { s, input } = this
    let iterator: AsyncIterator<InferenceEvent> | undefined
    let ended = false
    let sent = false
    let done = false
    try {
      s.loopScope.assertAlive()
      this.signal.throwIfAborted()
      const options = { signal: this.signal, toolNames: input.wire.tools.map((tool) => tool.name) }
      const send = () => {
        s.loopScope.assertAlive()
        this.signal.throwIfAborted()
        return s.d.provider.infer(input.wire, options)
      }
      const source = await interruptible(
        Promise.resolve(
          s.d.segments?.Inference
            ? runCoreReplacement(
                s,
                'Inference',
                input.context ?? s.operationContext(),
                { request: input.wire, options },
                async () => send(),
              )
            : send(),
        ),
        this.signal,
        (source) => {
          if (source && typeof source[Symbol.asyncIterator] === 'function')
            void Promise.resolve(source[Symbol.asyncIterator]().return?.()).catch(() => undefined)
        },
      )
      if (!source || typeof source[Symbol.asyncIterator] !== 'function')
        throw new Error('Inference replacement returned a non-async stream')
      iterator = source[Symbol.asyncIterator]()
      this.providerIterator = iterator
      for (;;) {
        const active = iterator
        const next = await interruptible(
          Promise.resolve().then(() => active.next()),
          this.signal,
        )
        if (next.done) {
          ended = true
          break
        }
        const event = next.value
        if (event.type === 'sent') {
          if (sent) throw new Error('duplicate sent')
          const { stamp } = event
          if (
            stamp.derived_hash !== input.header.derived_hash ||
            stamp.tool_schema_hash !== input.header.tool_schema_hash ||
            stamp.parser_version !== input.header.parser_version ||
            stamp.contract_id !== input.header.contract_id ||
            stamp.model.id !== input.wire.model ||
            stamp.model.route !== input.wire.route
          ) {
            this.error = {
              type: 'error',
              reason: 'error',
              code: 'CONTRACT_MISMATCH',
              message: 'provider sent stamp does not match the dispatched request',
              retryable: false,
            }
            yield this.error
            return
          }
          await s.d.log.append([
            s.ev('request/sent', stamp, { sourceEventSeqs: [input.headerSeq, input.intentSeq] }),
          ])
          sent = true
        } else if (!sent && event.type !== 'error') throw new Error('missing sent')
        s.loopScope.note()
        if (event.type === 'text_delta') this.text += event.delta
        if (event.type === 'thinking_delta') this.thinking += event.delta
        // Usage events describe totals for this request; the latest provider total wins.
        if (event.type === 'usage') this.usage = event
        if (event.type === 'done') {
          done = true
          this.completed = true
        }
        if (event.type === 'error') this.error = event
        if (event.type === 'done' || event.type === 'error') {
          this.closeProvider()
          ended = true
        }
        yield event
        if (event.type === 'done') return
        if (event.type === 'error') return
      }
      if (!sent || !done) throw new Error(!sent ? 'missing sent' : 'missing done')
    } catch (error) {
      this.error = {
        type: 'error',
        reason: this.cancellation.aborted ? 'aborted' : 'error',
        code: this.cancellation.aborted ? 'ABORTED' : 'TRANSPORT',
        message: error instanceof Error ? error.message : String(error),
        retryable: !this.cancellation.aborted,
      }
      yield this.error
    } finally {
      if (!ended) {
        this.controller.abort()
        // Provider cleanup must also run when the driver abandons its public iterator.
        this.closeProvider()
      }
    }
  }

  get outcome(): EffectOutcome {
    return this.cancellation.aborted || this.error?.reason === 'aborted'
      ? 'aborted'
      : this.error
        ? 'error'
        : this.completed
          ? 'ok'
          : 'aborted'
  }

  get content(): Array<{ type: 'text' | 'thinking'; text: string }> {
    return [
      ...(this.thinking ? [{ type: 'thinking' as const, text: this.thinking }] : []),
      ...(this.text ? [{ type: 'text' as const, text: this.text }] : []),
    ]
  }

  rows(outcome: EffectOutcome, interrupted: boolean): EventInput[] {
    const { usage, error, input } = this
    if (this.cancellation.aborted) {
      outcome = 'aborted'
      interrupted = true
    }
    const response = usage?.response ?? error?.response
    const spend: CostLedger = {
      purpose: 'inference',
      effectId: input.effect.effectId,
      model: input.wire.model,
      tokens: usage?.tokens ?? {
        input: 0,
        output: estimateTokens(this.text + this.thinking),
        cacheRead: 0,
        cacheWrite: 0,
      },
      ...(usage?.credits !== undefined ? { credits: usage.credits } : {}),
      creditSource: usage?.creditSource ?? 'estimated',
      ...(usage?.billing ? { billing: usage.billing } : {}),
      ...(usage?.timing ? { timing: usage.timing } : {}),
      ...(response ? { response } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    }
    return [this.s.ev('cost/ledger', spend), input.effect.settle(outcome)]
  }

  /** The same atomic settlement and billing record, whether called by a phase or a generic port. */
  commit(events: EventInput[], next: Parameters<SessionImpl['transition']>[1]): Promise<void> {
    if (this.recording)
      return this.recording.then(async () => {
        const continuation = events.filter(
          (row) =>
            !(
              ['cost/ledger', 'effect/settled'].includes(row.type) &&
              (row.data as { effectId?: string }).effectId === this.input.effect.effectId
            ),
        )
        if (continuation.length) {
          this.s.loopScope.assertAlive()
          await this.s.transition(continuation, next)
        }
      })
    this.accounted = true
    this.recording = this.record(events, next).finally(() => {
      this.cancellation.removeEventListener('abort', this.cancelReceipt)
      this.release()
      this.finishReceipt()
    })
    return this.recording
  }

  private async record(events: EventInput[], next: Parameters<SessionImpl['transition']>[1]): Promise<void> {
    const index = events.findIndex(
      (row) => row.type === 'cost/ledger' && (row.data as CostLedger).effectId === this.input.effect.effectId,
    )
    const cost = events[index]?.data as CostLedger | undefined
    if (!cost) throw new CoreError('E_RELATION', 'Model settlement requires exactly one spend')
    let costSeq: Seq | undefined
    let failed = false
    let failure: unknown
    try {
      costSeq = (await this.s.transition(events, next))[index]
    } catch (error) {
      failed = true
      failure = error
      if (error instanceof CoreError && typeof error.detail?.costSeq === 'number')
        costSeq = error.detail.costSeq
    }
    const ok = await this.s.d.runtime.billingRecord({
      ...cost,
      sessionKey: this.s.key,
      lane: this.s.lane,
      turn: this.op.turn,
      step: this.op.step,
    })
    if (!ok) {
      if (this.turn) this.turn.ledgerFailed = true
      if (this.s.loopScope.alive) await this.s.diag('seam-failed', { seam: 'billing', op: 'record' })
    }
    if (costSeq !== undefined) await settleTreeSpend(this.s, cost.credits, costSeq)
    if (failed) throw failure
  }
}
