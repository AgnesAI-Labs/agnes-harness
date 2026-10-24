import { randomBytes, randomUUID } from 'node:crypto'
import {
  applyBeforeRequestPatches,
  type ChildControlStore,
  type CostLedger,
  capToMicrocredits,
  chargeToMicrocredits,
  conservativeModelCredits,
  deriveRequest,
  hasChildControl,
  scanAll,
  toProviderRequest,
} from '@agnes/core'
import type { InferenceEvent } from '@agnes/protocol'
import { bestEffort } from '../../best-effort.js'
import type { HostSession } from '../lifecycle/host.js'

export type SideQuestionFailure = 'budget' | 'unavailable' | 'timeout' | 'failed'

/** The side question could not be answered; `code` says why without leaking provider detail. */
export class SideQuestionError extends Error {
  constructor(
    readonly code: SideQuestionFailure,
    message: string,
  ) {
    super(message)
    this.name = 'SideQuestionError'
  }
}

/** Which auxiliary slots a review may use, in order; the first one with a configured model wins. */
export type SideQuestionSlot = 'verifier' | 'fast'

export type SideQuestionOptions = {
  timeoutMs?: number
  signal?: AbortSignal
  /** Use the first configured auxiliary slot instead of the primary model (no primary fallback). */
  slots?: readonly SideQuestionSlot[]
  system?: string
  maxTokens?: number
  /** Names the cost row and request key, default `btw`. */
  label?: string
}

export type SideQuestionAnswer = { text: string; model: string; credits?: number }

const SYSTEM = [
  'Answer the side question from the conversation above.',
  'You cannot call tools or change anything; answer only from what the conversation already shows.',
  'Keep the answer short and reply in the language of the question.',
].join(' ')
const MAX_TOKENS = 2048
const MAX_TEXT = 16_000

/**
 * One read-only model call about a session's conversation. Neither the question nor the answer is
 * written to the ledger; the only durable trace is the `side-call` cost row. Once the provider
 * has been called a timeout, cancel or provider error still appends that row (interrupted, with
 * estimated tokens when no usage arrived) because tokens may have been billed; a refusal or an
 * abort before dispatch appends nothing and releases its reservation.
 */
export async function askSideQuestion(
  s: HostSession,
  question: string,
  options: SideQuestionOptions = {},
): Promise<SideQuestionAnswer> {
  const work = () => ask(s, question, options)
  return s.d.withModelSnapshot ? s.d.withModelSnapshot(work) : work()
}

async function ask(
  s: HostSession,
  question: string,
  options: SideQuestionOptions,
): Promise<SideQuestionAnswer> {
  if (s.closingOrClosed) throw new SideQuestionError('unavailable', 'session is closed')
  const label = options.label ?? 'btw'
  const find = (slot: 'primary' | SideQuestionSlot) => {
    const route = s.preset.model.route[slot]
    const id =
      s.preset.model.id[slot] ??
      (slot === 'primary'
        ? s.d.provider.models().find((m) => m.route === route && m.slot === 'primary')?.id
        : undefined)
    const model =
      route && id ? s.d.provider.models().find((m) => m.route === route && m.id === id) : undefined
    return route && id && model ? { slot, route, modelId: id, model } : undefined
  }
  const picked = options.slots ? options.slots.map(find).find((x) => x !== undefined) : find('primary')
  if (!picked) throw new SideQuestionError('unavailable', 'side model unavailable')
  const { route, modelId, model } = picked

  const abort = new AbortController()
  const cancel = () => abort.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, options.timeoutMs ?? 60_000)
  const signal = abort.signal
  const stopped = () => new SideQuestionError('timeout', 'side question cancelled or timed out')
  let permit: { store: ChildControlStore; id: string } | undefined
  try {
    if (options.signal?.aborted) abort.abort()
    // Read the nodes and their bound in one synchronous step so the cut below is consistent.
    const nodes = s.surface()
    const upto = s.lastSeq
    const [start] = await s.scan({ type: 'turn/start', lane: s.lane, toSeq: upto, order: 'desc', limit: 1 })
    const [end] = await s.scan({ type: 'turn/end', lane: s.lane, toSeq: upto, order: 'desc', limit: 1 })
    // An open turn may hold tool calls that have no result yet, so only what precedes it is shown.
    const open = start !== undefined && (end === undefined || end.seq < start.seq)
    const surface = open ? nodes.filter((n) => n.seq < start.seq) : [...nodes]
    const owners = new Set(surface.filter((n) => n.kind === 'assistant').map((n) => n.seq))
    const first = [...owners][0]
    const toolCalls: Array<{
      assistantSeq: number
      toolUseId: string
      name: string
      args: unknown
      ordinal: number
    }> = []
    if (first !== undefined) {
      let owner: number | undefined
      for (const row of await scanAll((q) => s.scan(q), {
        fromSeq: first,
        toSeq: upto,
        type: ['assistant/message', 'tool/call'],
        lane: s.lane,
      })) {
        if (row.type === 'assistant/message') {
          owner = row.seq
          continue
        }
        const d = row.data as {
          toolUseId?: unknown
          name?: unknown
          args?: unknown
          ordinal?: unknown
          depth?: unknown
        }
        if (owner === undefined || !owners.has(owner) || (typeof d.depth === 'number' && d.depth > 0))
          continue
        toolCalls.push({
          assistantSeq: owner,
          toolUseId: String(d.toolUseId),
          name: String(d.name),
          args: d.args,
          ordinal: Number(d.ordinal ?? 0),
        })
      }
    }

    const target = { route, model: modelId }
    let derived = deriveRequest({
      kind: 'summary',
      merged: { tools: [], sections: [], runtimeContext: {}, conflicts: [] },
      harnessEntries: [],
      surface,
      disclosed: [],
      toolCalls,
      model: { slot: picked.slot, ...target },
      contract: s.d.contractForModel?.(target) ?? s.d.contract,
      nonce: randomBytes(16).toString('hex'),
      envelopeNonceFor: (seq) => s.envelopeNonceFor(seq),
      envelopeCache: s.envelopeCache,
      summaryPlan: { system: options.system ?? SYSTEM, instruction: question },
    })
    const maxTokens = Math.min(options.maxTokens ?? MAX_TOKENS, model.maxTokens)
    derived = applyBeforeRequestPatches(derived, [{ ext: `host:${label}`, patch: { maxTokens } }])
    const wire = toProviderRequest(derived.request, {
      sessionKey: `${label}:${randomUUID()}`,
      derivedHash: derived.header.derived_hash,
    })

    const tokens = new TextEncoder().encode(JSON.stringify(wire)).byteLength + maxTokens
    const projected = await abortable(
      s.d.runtime.billingProjected({ tokensEstimate: tokens, model: modelId }),
      signal,
      stopped,
    )
    const hold = Math.max(projected.credits, conservativeModelCredits(tokens, maxTokens, model.cost))
    // An auxiliary review honours the open turn's budget override exactly like `generate` does.
    let cap = s.preset.budget.perRequestCap
    if (options.slots) {
      const override = (await s.scan({ type: 'x/core/turn-budget', order: 'desc', limit: 1 }))[0]?.data as
        | { turn?: number; hard?: boolean; creditsCap?: number | null }
        | undefined
      const turnNo = (start?.data as { turn?: number } | undefined)?.turn
      if (override && override.turn === turnNo) {
        if (override.hard) throw new SideQuestionError('budget', 'turn budget is hard-capped')
        cap = override.creditsCap ?? cap
      }
    }
    if (!Number.isFinite(hold) || (cap !== null && hold > cap))
      throw new SideQuestionError('budget', 'side question exceeds the per-request budget')
    const effectId = `${label}:${randomUUID()}`
    if (s.preset.treeBudgetCredits !== null) {
      const store = s.d.log.storage
      if (!hasChildControl(store) || !start)
        throw new SideQuestionError('budget', 'tree budget unavailable for a side question')
      const rootTaskId = `${s.key}:${s.lane}:${start.seq}`
      const scope = await store.ensureRootScope(rootTaskId, capToMicrocredits(s.preset.treeBudgetCredits))
      const reserved = await store.reserve({
        rootTaskId,
        scopeIds: [scope.scopeId],
        qMicro: chargeToMicrocredits(hold),
        effectId,
        requestHash: derived.header.derived_hash,
        writerGeneration: (await store.writerGeneration?.(rootTaskId)) ?? 1,
      })
      if (!reserved.ok) throw new SideQuestionError('budget', 'tree budget exhausted')
      permit = { store, id: reserved.permitId }
    }
    if (signal.aborted) throw stopped()

    let usage: Extract<InferenceEvent, { type: 'usage' }> | undefined
    let text = ''
    let completed = false
    // From here the provider may bill tokens whatever happens next, so a failure is still accounted.
    let failure: unknown
    try {
      const iterator = s.d.provider
        .infer(wire, { signal, toolNames: [], retry: false })
        [Symbol.asyncIterator]()
      try {
        while (true) {
          const next = await abortable(iterator.next(), signal, stopped)
          if (next.done) break
          const event = next.value
          if (event.type === 'usage') usage = event
          if (event.type === 'text_delta') text += event.delta
          if (text.length > MAX_TEXT) {
            text = text.slice(0, MAX_TEXT)
            completed = true
            break
          }
          if (event.type === 'done') {
            completed = event.reason === 'stop' || event.reason === 'length'
            break
          }
          if (event.type === 'error' || event.type === 'toolcall_end' || event.type === 'deviation') break
        }
      } finally {
        // Early stream cancellation can reject return(); settlement remains owned by this request.
        void iterator.return?.().catch(() => undefined)
      }
    } catch (error) {
      failure = error
    }
    if (!failure && signal.aborted && !completed) failure = stopped()

    const turn = (start?.data as { turn?: number } | undefined)?.turn
    const spend: CostLedger = {
      purpose: 'side-call',
      ...(typeof turn === 'number' && turn >= 1 ? { sourceTurn: turn } : {}),
      effectId,
      model: modelId,
      route,
      tokens: usage?.tokens ?? {
        input: tokens,
        output: Math.ceil(text.length / 4),
        cacheRead: 0,
        cacheWrite: 0,
      },
      creditSource: usage?.creditSource ?? 'estimated',
      ...(usage?.credits === undefined ? {} : { credits: usage.credits }),
      ...(usage?.billing ? { billing: usage.billing } : {}),
      ...(!completed ? { interrupted: true } : {}),
    }
    // The append is the durable fact; if it fails the reservation is released by the finally below.
    const appended = await s.locked(() => s.append([s.ev('cost/ledger', spend)]))
    if (permit) {
      await permit.store.settleOrigin({
        permitId: permit.id,
        originSessionKey: s.key,
        originCostSeq: appended.firstSeq,
        actualMicro: usage?.credits === undefined ? null : chargeToMicrocredits(usage.credits),
        complete: usage?.credits !== undefined,
        creditSource: usage?.creditSource ?? 'unknown',
      })
      permit = undefined
    }
    await s.d.runtime.billingRecord({
      ...spend,
      sessionKey: s.key,
      lane: s.lane,
      turn: typeof turn === 'number' ? turn : 0,
      step: 0,
    })
    if (failure) throw failure
    if (!completed || !text.trim()) throw new SideQuestionError('failed', 'the model returned no answer')
    return { text, model: modelId, ...(usage?.credits === undefined ? {} : { credits: usage.credits }) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    abort.abort()
    // Still held only when the provider was never called or accounting itself failed.
    if (permit)
      await permit.store
        .releaseReservation(permit.id)
        .catch(bestEffort(s.d.logger, 'side-question-reservation-release'))
  }
}

/** An uncooperative adapter must not hold the request open past its deadline. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(onAbort())
  })
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) abort()
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
