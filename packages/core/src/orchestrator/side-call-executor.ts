import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import type { EffectHandle } from '@agnes/core-effects/effects/effect'
import { armTimeout } from '@agnes/core-effects/effects/wrap'
import type { PreparedSideCall, SideCallResult } from '@agnes/extension-api'
import type { CostLedger } from '@agnes/extension-api/seams'
import { type AiErrorCode, type InferenceEvent, type RequestBody, validateEvent } from '@agnes/protocol'
import {
  reconcileTreeReservationHandle,
  releaseTreeReservationHandle,
  reserveTreeBudgetHandle,
  settleTreeSpendHandle,
  type TreeReservationHandle,
} from '../child/runtime-budget.js'
import { ModelExecution } from '../execution/model-execution.js'
import type { SessionImpl } from '../step/session.js'
import type {
  SideCallEffectAudit,
  SideCallEffectBinding,
  SideCallEffectPort,
} from './side-call-effect-port.js'
import {
  bounded,
  checkSideCallSettlement,
  count,
  MAX_OUTPUT_TEXT,
  MAX_RETRY_AFTER_MS,
  type SideCallEffectTerminal,
  type SideCallKnownReason,
  type SideCallNoSpendReason,
  type SideCallUnknownReason,
  sideCallResult,
  type TerminalKind,
} from './side-call-terminal.js'

type Usage = Extract<InferenceEvent, { type: 'usage' }>
type Failure = Extract<InferenceEvent, { type: 'error' }>
/** A cost row as a model execution writes it, with the response metadata it copies from usage. */
type Spend = CostLedger & { response?: Readonly<{ id?: unknown; model?: unknown }> }

/** One prepared side call: what the loop holds, the frozen request, and its ledger identity. */
export type SideCallPlan = Readonly<{
  prepared: PreparedSideCall
  request: RequestBody
  binding: SideCallEffectBinding
  audit: SideCallEffectAudit
}>

/** What the stream showed: the text, the latest usage, and how it ended. */
type Observed = { text: string; usage?: Usage; error?: Failure; done: boolean }

/** How a call ended, decided before its rows are built; the spend comes from the cost row. */
type Ending = Readonly<{
  kind: TerminalKind
  outcome: 'ok' | 'error' | 'aborted'
  interrupted: boolean
  reason?: SideCallKnownReason | SideCallNoSpendReason | SideCallUnknownReason
  code?: AiErrorCode
  retryable?: boolean
  retryAfterMs?: number
  text?: string
}>

/**
 * The wait the vendor asked for before a retry, when the adapter error carried one: rounded up to a
 * whole millisecond and kept only up to the cap. Anything else is dropped, not treated as an error.
 */
function retryHint(error: Failure | undefined): { retryAfterMs?: number } {
  const value = error?.retryAfterMs
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return {}
  const ms = Math.ceil(value)
  return ms <= MAX_RETRY_AFTER_MS ? { retryAfterMs: ms } : {}
}

// A probe envelope for checking a row's data before it is written; the log assigns the real values.
const PROBE_TS = new Date(0).toISOString()
const PROBE_ID = '0'.repeat(26)

const parses = (text: string) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Maps what happened to a terminal. A cut call is a deadline when Core's own timer cut it, a
 * session stop when the turn is being cancelled, and otherwise a caller cancellation; only a
 * session stop is recorded as aborted. A request that certainly did not leave spends nothing.
 */
function ending(
  execution: ModelExecution,
  seen: Observed,
  deadline: boolean,
  stopping: boolean,
  output: 'text' | 'json',
): Ending {
  const cut = execution.cancellation.aborted || deadline
  const cutBy = deadline
    ? ({ reason: 'deadline_exceeded', outcome: 'error', code: 'TIMEOUT' } as const)
    : stopping
      ? ({ reason: 'session_cancelled', outcome: 'aborted' } as const)
      : ({ reason: 'caller_cancelled', outcome: 'error' } as const)
  const spent = seen.usage ? 'known_spend' : 'unknown_spend'
  if (!execution.mayHaveSent)
    return cut
      ? { kind: 'no_spend', interrupted: true, ...cutBy, reason: 'cancelled_before_dispatch' }
      : {
          kind: 'no_spend',
          outcome: 'error',
          interrupted: true,
          reason: 'driver_not_sent',
          code: seen.error?.code ?? 'TRANSPORT',
          retryable: seen.error?.retryable ?? true,
          ...retryHint(seen.error),
        }
  if (cut) return { kind: spent, interrupted: true, ...cutBy }
  if (seen.done && !seen.error) {
    // A completed call that reports no usage cannot be accounted as a success.
    if (!seen.usage)
      return {
        kind: 'unknown_spend',
        outcome: 'error',
        interrupted: true,
        reason: 'adapter_error',
        code: 'TRANSPORT',
        retryable: true,
      }
    if (seen.text.length > MAX_OUTPUT_TEXT)
      return { kind: 'known_spend', outcome: 'error', interrupted: false, reason: 'invalid_output', text: '' }
    if (output === 'json' && !parses(seen.text))
      return {
        kind: 'known_spend',
        outcome: 'error',
        interrupted: false,
        reason: 'invalid_output',
        text: seen.text,
      }
    return { kind: 'known_spend', outcome: 'ok', interrupted: false, text: seen.text }
  }
  return {
    kind: spent,
    outcome: 'error',
    interrupted: true,
    reason: seen.usage ? 'driver_failed' : 'adapter_error',
    code: seen.error?.code ?? 'TRANSPORT',
    retryable: seen.error?.retryable ?? true,
    ...retryHint(seen.error),
  }
}

/** The terminal for an ending, repeating the spend of the cost row it is committed with. */
function terminalOf(end: Ending, cost: Spend, latencyMs: number): SideCallEffectTerminal {
  const durations = Object.fromEntries(
    (['ttftMs', 'durationMs'] as const)
      .filter((key) => count(cost.timing?.[key]))
      .map((key) => [key, cost.timing?.[key]]),
  )
  const timing = Object.keys(durations).length ? { timing: durations } : {}
  const response = Object.fromEntries(
    (['id', 'model'] as const)
      .filter((key) => bounded(cost.response?.[key], key === 'id' ? 128 : 256))
      .map((key) => [key, cost.response?.[key]]),
  )
  const spend =
    end.kind === 'no_spend'
      ? {}
      : {
          tokens: cost.tokens,
          ...(cost.credits === undefined ? {} : { credits: cost.credits }),
          creditSource: cost.creditSource,
          ...(end.kind === 'known_spend' && cost.billing ? { billing: cost.billing } : {}),
          ...timing,
        }
  return {
    kind: end.kind,
    outcome: end.outcome,
    purpose: 'side-call',
    model: cost.model,
    interrupted: end.interrupted,
    ...spend,
    ...(end.text === undefined ? {} : { text: end.text }),
    ...(end.outcome === 'ok' && Object.keys(response).length ? { response } : {}),
    ...(end.reason ? { reason: end.reason } : {}),
    ...(end.code ? { code: end.code } : {}),
    ...(end.retryable === undefined ? {} : { retryable: end.retryable }),
    ...(end.retryAfterMs === undefined ? {} : { retryAfterMs: end.retryAfterMs }),
    latencyMs,
  } as SideCallEffectTerminal
}

const refused = (invocationId: string, reason: 'budget' | 'usage-unrecorded'): SideCallResult =>
  Object.freeze({ status: 'refused', invocationId, reason })

const cancelled = (invocationId: string, dispatch: 'not-sent' | 'may-have-sent', latencyMs: number) =>
  Object.freeze({
    status: 'failed' as const,
    invocationId,
    reason: 'cancelled' as const,
    retryable: false,
    dispatch,
    latencyMs,
    replayed: false,
  })

/**
 * Settles the tree budget hold against the recorded spend. The cost row is already committed, so a
 * settlement that still fails after reconciling is not thrown: it is logged and, while the scope
 * can still write, recorded as a seam failure naming only the effect. The hold stays counted
 * against the tree.
 */
async function settleHold(
  s: SessionImpl,
  hold: TreeReservationHandle,
  credits: number | undefined,
  costSeq: Seq,
  source: 'gateway' | 'estimated',
): Promise<void> {
  const creditSource = credits === undefined ? 'unknown' : source
  try {
    await settleTreeSpendHandle(s, hold, credits, costSeq, creditSource).catch(async (error: unknown) => {
      const reconciled = await reconcileTreeReservationHandle(s, hold)
      if (reconciled.status === 'held') return settleTreeSpendHandle(s, hold, credits, costSeq, creditSource)
      if (reconciled.status !== 'settled' && reconciled.status !== 'unknown') throw error
    })
  } catch (error) {
    s.d.logger.warn('side call tree budget settlement failed', { sessionKey: s.key, error: String(error) })
    if (s.loopScope.alive)
      await s.diag('seam-failed', { seam: 'tree-budget', op: 'settle', effectId: hold.effectId })
  }
}

/**
 * Admits, records and sends one prepared side call, then commits how it ended. Admission refusals
 * and a cancellation before the intent write nothing. After the intent, the call runs on a model
 * execution that races its own deadline timer and the caller's and session's signals, and the cost
 * row, settlement and terminal are committed together through the effect port, which appends them
 * without a phase transition. The commit always runs, even when the stream fails, because the
 * execution's receipt holds the session's close until it is written.
 */
export async function executeSideCall(
  s: SessionImpl,
  effects: SideCallEffectPort,
  plan: SideCallPlan,
  signal: AbortSignal,
): Promise<SideCallResult> {
  const { prepared, binding, audit } = plan
  const { invocationId, estimate } = prepared
  const projected = estimate.projectedCredits
  if (s.turn?.ledgerFailed) return refused(invocationId, 'usage-unrecorded')
  const cap = s.turnBudgetCap()
  // An unpriced estimate cannot be shown to fit a cap, so it is refused when one is set.
  if (cap !== null && (projected === null || projected > cap)) return refused(invocationId, 'budget')
  const reserved = await reserveTreeBudgetHandle(
    s,
    projected ?? Number.POSITIVE_INFINITY,
    prepared.target,
    { effectId: binding.effectId, requestHash: binding.auditBindingHash },
    estimate.inputTokens,
  )
  if (reserved.status === 'blocked' || reserved.status === 'terminal') return refused(invocationId, 'budget')
  const hold = reserved.status === 'reserved' ? reserved.handle : undefined
  if (signal.aborted || s.ac.signal.aborted) {
    if (hold) await releaseTreeReservationHandle(s, hold)
    return cancelled(invocationId, 'not-sent', 0)
  }
  let intentSeq: Seq
  try {
    intentSeq = await effects.begin(binding, audit)
  } catch (error) {
    if (hold) await releaseTreeReservationHandle(s, hold)
    throw error
  }
  return dispatch(s, effects, plan, signal, intentSeq, hold)
}

async function dispatch(
  s: SessionImpl,
  effects: SideCallEffectPort,
  plan: SideCallPlan,
  signal: AbortSignal,
  intentSeq: Seq,
  hold: TreeReservationHandle | undefined,
): Promise<SideCallResult> {
  const { prepared, binding, audit } = plan
  // Latency is Core's own measure from dispatch, whenever the adapter's first event arrives.
  const started = performance.now()
  const elapsed = () => Math.max(0, Math.round(performance.now() - started))
  const projected = prepared.estimate.projectedCredits
  const adapter = prepared.adapter
  const seen: Observed = { text: '', done: false }
  const audited = {
    route: binding.route,
    ...(adapter
      ? { adapter: { id: adapter.id, ...(adapter.version === null ? {} : { version: adapter.version }) } }
      : {}),
    ...(adapter?.endpointHost ? { endpointHost: adapter.endpointHost } : {}),
  }
  // Where the committed cost row's credits came from, for the tree budget settlement. A revoked call
  // settles through the model execution alone, with the usage it saw.
  let spendSource: 'gateway' | 'estimated' | undefined
  const usageSource = () =>
    seen.usage?.credits !== undefined && seen.usage.creditSource === 'gateway' ? 'gateway' : 'estimated'
  // The settlement row carries the code the terminal records, decided before the rows are built.
  let code: AiErrorCode | undefined
  const effect: EffectHandle = {
    effectId: binding.effectId,
    intent: s.ev('effect/intent', { effectId: binding.effectId, kind: 'side-call', replay: 'never' }),
    settle: (outcome) =>
      s.ev('effect/settled', {
        effectId: binding.effectId,
        outcome,
        ...(code ? { code } : {}),
        durationMs: elapsed(),
      }),
  }
  const execution = new ModelExecution(s, {
    wire: plan.request,
    effect,
    intentSeq,
    signal,
    turnId: s.op()?.meta.turn ?? 0,
    step: s.state.openStep.get(s.lane)?.step ?? 0,
    memory: s.turn,
    purpose: 'side-call',
    unobserved: { inputTokens: audit.inputTokens, ...(projected === null ? {} : { credits: projected }) },
    settleTreeBudget: async (credits, costSeq) => {
      if (hold) await settleHold(s, hold, credits, costSeq, spendSource ?? usageSource())
    },
    outcomeFromCaller: true,
    retry: false,
    replaceable: false,
    extraCostFields: audited,
    write: (events) => effects.write(events),
  })
  let deadline = false
  // Core's own timer, not the adapter, ends a call at its deadline.
  const disarm = armTimeout(() => {
    if (execution.signal.aborted) return
    deadline = true
    execution.controller.abort()
  }, prepared.deadlineMs)

  /**
   * The batch Core writes when the adapter's own output cannot be recorded as given, for example an
   * error code outside the protocol's set or a usage report of another shape. It is built from
   * Core's values only, all checked before the intent was written, so it is always recordable: a
   * transport failure that is not retryable, with an estimate if the request may have left and
   * zero spend if it certainly did not.
   */
  function unreadable(): { batch: EventInput[]; terminal: SideCallEffectTerminal } {
    const sent = execution.mayHaveSent
    const end: Ending = {
      kind: sent ? 'unknown_spend' : 'no_spend',
      outcome: 'error',
      interrupted: true,
      reason: sent ? 'adapter_error' : 'driver_not_sent',
      code: 'TRANSPORT',
      retryable: false,
    }
    code = end.code
    const credits = sent ? projected : 0
    const cost = s.ev('cost/ledger', {
      purpose: 'side-call',
      effectId: binding.effectId,
      model: binding.model,
      tokens: { input: sent ? audit.inputTokens : 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(credits === null ? {} : { credits }),
      creditSource: 'estimated',
      interrupted: true,
      ...audited,
    })
    const terminal = terminalOf(end, cost.data as Spend, elapsed())
    return { batch: [cost, effect.settle('error'), effects.terminalRow(binding, terminal)], terminal }
  }

  /**
   * Refuses a batch the effect port or the ledger would refuse, by the same checks they apply, so
   * a settlement is never sent without the terminal that has to go with it.
   */
  function recordable(batch: EventInput[]): void {
    const terminalRow = batch[batch.length - 1] as EventInput
    checkSideCallSettlement(batch, binding, (terminalRow.data as { bindingHash: string }).bindingHash)
    for (const row of batch)
      if (!validateEvent({ lane: s.lane, v: 1, ...row, ts: PROBE_TS, id: PROBE_ID, seq: 1 }).ok)
        throw new CoreError('E_ENVELOPE', 'side-call settlement row does not match its schema')
  }

  async function settle(): Promise<SideCallResult> {
    const stopping = s.op()?.control.status === 'cancel_requested'
    let batch: EventInput[]
    let terminal: SideCallEffectTerminal
    try {
      const end = ending(execution, seen, deadline, stopping, audit.output)
      code = end.code
      const [row, ...rest] = execution.rows(end.outcome, end.interrupted) as [EventInput, ...EventInput[]]
      // Usage that names no credits is priced at the frozen estimate, so the spend is never blank.
      const cost =
        seen.usage && (row.data as CostLedger).credits === undefined
          ? {
              ...row,
              data: { ...(row.data as CostLedger), credits: projected ?? 0, creditSource: 'estimated' },
            }
          : row
      terminal = terminalOf(end, cost.data as Spend, elapsed())
      batch = [cost, ...rest, effects.terminalRow(binding, terminal)]
      recordable(batch)
    } catch {
      // The reason is left out on purpose: validation messages can quote the adapter's values.
      s.d.logger.warn('side call output could not be recorded as given', { sessionKey: s.key })
      ;({ batch, terminal } = unreadable())
    }
    spendSource = ((batch[0] as EventInput).data as CostLedger).creditSource
    try {
      await execution.commit(batch, (cur) => cur)
    } catch (error) {
      if (!(error instanceof CoreError && error.code === 'E_CLOSED')) throw error
      // The scope was revoked: the call closed with a late receipt and its output was not kept.
      return cancelled(prepared.invocationId, 'may-have-sent', elapsed())
    }
    return sideCallResult(terminal, {
      invocationId: prepared.invocationId,
      output: audit.output,
      replayed: false,
    })
  }

  let result: SideCallResult | undefined
  try {
    const waited = s.loopScope.beginWait()
    try {
      for await (const event of execution.stream()) {
        if (event.type === 'text_delta') seen.text += event.delta
        else if (event.type === 'usage') seen.usage = event
        else if (event.type === 'done') seen.done = true
        else if (event.type === 'error') seen.error = event
      }
    } finally {
      waited()
    }
  } finally {
    disarm()
    result = await settle()
  }
  return result
}
