import type { LoopStepOutcome, LoopTurnView, ToolResult } from '@agnes/extension-api'
import { observeDispatch } from './dispatch.js'
import { type JevOutcome, resumeJev } from './jev.js'
import { parseReply } from './llm.js'
import { afterError, type ErrorEvent } from './model.js'
import {
  emitMetrics,
  emitStep,
  endStep,
  finishTurn,
  recordRefusal,
  refusalOf,
  type Scope,
  save,
} from './scope.js'
import {
  countJev,
  decodeAndRoute,
  dispatchEvent,
  dispatchStep,
  handleReply,
  jevDeps,
  llmStep,
  readOnlyOf,
  routeEvent,
  stepTools,
} from './step.js'
import type { CurrentStep, InferenceEvent, JsonObject, PendingCall, Route } from './types.js'
import { clip, errorCode } from './util.js'

const idPrefix = (s: Scope) => `jev:${s.state.idTurn}:${s.state.step}`

/** The route of the interrupted step, from its checkpointed decision. */
function savedRoute(s: Scope): Route {
  const { decision, route } = s.state.cur
  if (!decision || !route) throw new Error('The interrupted Jev loop step has no recorded route')
  return { kind: route.kind, reason: route.reason, decision }
}

/** The ids of the step's model attempts up to `k`: an attempt is only retried after it was sent. */
function llmIds(s: Scope, k: number): string[] {
  return Array.from({ length: k + 1 }, (_, i) => `${idPrefix(s)}:m${i}`)
}

/** The model part of an interrupted step's event, rebuilt from its recorded attempt. */
function recordedLlm(s: Scope): { llm?: JsonObject } {
  const llm = s.state.cur.llm
  if (!llm) return {}
  const ids = llmIds(s, llm.attempt)
  return {
    llm: { kind: llm.kind, attempts: ids.length, invocationIds: ids, droppedCalls: 0, outcome: 'call' },
  }
}

/**
 * Counts the step's model attempts below `upTo` that the counters do not hold yet, and records them
 * as counted so a second restart in the same step does not count them again. Every attempt after
 * the step's first is a retry.
 */
function countSent(s: Scope, llm: NonNullable<CurrentStep['llm']>, upTo: number): void {
  const from = llm.counted ?? 0
  if (upTo <= from) return
  s.state.counters.llm[llm.kind] += upTo - from
  s.state.counters.llm.retries += Math.max(0, upTo - Math.max(from, 1))
  llm.counted = upTo
}

/** The turn was cancelled, possibly while the process was down. */
async function turnCancelled(s: Scope, signal: AbortSignal, view?: LoopTurnView | null): Promise<boolean> {
  if (signal.aborted || s.ctx.turn.cancelled()) return true
  const current = view === undefined ? await s.ctx.turn.view() : view
  return current?.cancelled === true
}

const notRun = (call: PendingCall): ToolResult => ({
  content: [{ type: 'text', text: `${call.name} was announced but did not run` }],
  isError: true,
})

/** Replays the recorded calls with their ids before anything else is prepared. */
async function recoverDispatch(s: Scope, signal: AbortSignal): Promise<LoopStepOutcome> {
  const calls = s.state.cur.calls
  if (!calls?.length) throw new Error('The interrupted Jev loop dispatch has no recorded call')
  return dispatchStep(s, calls, savedRoute(s), signal, { replay: true, ...recordedLlm(s) })
}

/**
 * Reads the receipt of the recorded model attempt: a recorded reply is used without a new request,
 * an unsent attempt is sent again with the same id, and one that may have been sent is not resent.
 * A recorded error follows the same retry policy as a live request.
 */
async function recoverLlm(s: Scope, signal: AbortSignal): Promise<LoopStepOutcome> {
  const llm = s.state.cur.llm
  if (!llm) throw new Error('The interrupted Jev loop model request has no record')
  const route = savedRoute(s)
  const { kind, attempt: k } = llm
  // An attempt is only retried after it was sent.
  countSent(s, llm, k)
  if (await turnCancelled(s, signal)) return finishTurn(s, 'aborted')
  const receipt = await s.ctx.effects.status(`${idPrefix(s)}:m${k}`)
  if (receipt.status === 'not-sent') {
    // Only the first attempt carries the note; a later one finds it already committed.
    return llmStep(s, route, signal, k, k === 0 ? (llm.note ?? '') : '')
  }
  delete llm.note
  countSent(s, llm, k + 1)
  const ids = llmIds(s, k)
  const llmEvent: JsonObject = { kind, attempts: ids.length, invocationIds: ids, droppedCalls: 0 }
  if (receipt.status === 'may-have-sent') {
    const obs = recordRefusal(s, {
      phase: route.decision.phase,
      op: route.decision.op,
      target: null,
      code: 'LLM_OUTCOME_UNKNOWN',
      stage: 'llm',
      message: 'model request may have been sent',
    })
    return endStep(s, obs, {
      ...routeEvent(route),
      llm: { ...llmEvent, outcome: 'unknown' },
      refusal: refusalOf(obs),
    })
  }
  if (!Array.isArray(receipt.result)) throw new Error('The Jev loop model receipt holds no model events')
  const events = receipt.result as readonly InferenceEvent[]
  const error = events.find((event): event is ErrorEvent => event.type === 'error')
  if (!error) return handleReply(s, route, parseReply(events), llmEvent, signal)
  const errorEvent = { ...routeEvent(route), llm: { ...llmEvent, outcome: 'error' } }
  if (error.reason === 'aborted') {
    await emitStep(s, errorEvent)
    return finishTurn(s, 'aborted')
  }
  const next = await afterError(error, k, s.cfg.llmMaxAttempts, s.ctx, signal)
  if (next.kind === 'retry') return llmStep(s, route, signal, k + 1, '')
  await emitStep(s, errorEvent)
  // Compaction ended the turn.
  if (next.kind === 'outcome') return next.outcome
  return finishTurn(s, 'error', {
    code: 'JEV_LOOP_MODEL_FAILED',
    message: `${error.code}: ${clip(error.message, 200)}`,
  })
}

/** Reads back the step's last Jev call: the workspace has not changed, so the questions are the same. */
async function recoverDecide(s: Scope, signal: AbortSignal): Promise<LoopStepOutcome> {
  const st = s.state
  const lastId = st.cur.jevAttempts.at(-1)
  if (lastId === undefined) throw new Error('The interrupted Jev loop decision has no recorded call')
  const view = await s.ctx.turn.view()
  if (!view) throw new Error('The claimed Jev loop turn has no public view')
  if (await turnCancelled(s, signal, view)) return finishTurn(s, 'aborted')
  const { tools, compiled, build } = stepTools(s, view)
  const { deps, sent } = jevDeps(s)
  let outcome: JevOutcome
  try {
    outcome = await resumeJev(
      {
        route: s.cfg.jev.route,
        model: s.cfg.jev.model,
        deadlineMs: s.cfg.jev.deadlineMs,
        maxRetries: s.cfg.jev.maxRetries,
        idPrefix: idPrefix(s),
        usedAttempts: st.cur.jevAttempts.length,
        level: st.cur.level,
        build,
        lastId,
      },
      deps,
      signal,
    )
  } catch (error) {
    if (errorCode(error) !== 'E_CLOSED') throw error
    outcome = { kind: 'cancelled' }
  } finally {
    countJev(s, sent())
  }
  return decodeAndRoute(s, outcome, compiled, tools, signal)
}

/** Picks up a step of the current turn that a restart interrupted after its first recorded effect. */
export async function recoverStep(s: Scope, signal: AbortSignal): Promise<LoopStepOutcome> {
  const stage = s.state.stage
  if (stage === 'dispatch') return recoverDispatch(s, signal)
  if (stage === 'llm') return recoverLlm(s, signal)
  if (stage === 'decide') return recoverDecide(s, signal)
  throw new Error(`The Jev loop cannot recover a step at stage ${stage}`)
}

/**
 * The approval continuation: the same turn goes on under a new Core turn id. Goal, notes, step and
 * invocation ids are kept; the parked calls are resumed, read from their receipts, or recorded as
 * not run.
 */
async function continueApproval(s: Scope, signal: AbortSignal): Promise<LoopStepOutcome> {
  const st = s.state
  const view = await s.ctx.turn.view()
  if (!view) throw new Error('The Jev loop approval continuation has no open turn')
  st.coreTurn = view.turnId
  const calls = st.cur.calls ?? []
  if (calls.length === 0) throw new Error('The Jev loop approval continuation has no recorded call')
  const results: ToolResult[] = []
  let waiting = false
  for (const call of calls) {
    const receipt = await s.ctx.effects.status(call.invocationId)
    if (receipt.status === 'may-have-sent') {
      // A PARKED refusal goes to the driver, which parks again with the same ids.
      try {
        results.push(await s.ctx.tools.resume(call.invocationId, signal))
      } catch (error) {
        if (errorCode(error) !== 'E_LANE_BUSY') throw error
        waiting = true
      }
    } else if (receipt.status === 'responded') {
      if (Array.isArray(receipt.result)) throw new Error('The Jev loop tool receipt holds model events')
      results.push(receipt.result as ToolResult)
    } else results.push(notRun(call))
  }
  if (waiting) {
    // The call still waits for its own approval: the park is kept for the next continuation.
    st.stage = 'parked'
    await save(
      s,
      calls.map((call) => call.invocationId),
    )
    await s.ctx.events.finish('parked')
    return { outcome: 'parked', reason: 'parked' }
  }
  const route = savedRoute(s)
  const { decision } = route
  const only = calls.length === 1 ? calls[0] : undefined
  const readOnly = only === undefined ? undefined : readOnlyOf(view, st.toolNames, only.name)
  const obs = observeDispatch({
    phase: decision.phase,
    calls,
    results,
    cwd: s.cwd,
    confidence: decision.confidence,
    escalated: route.kind === 'arbitration',
    ...(readOnly === undefined ? {} : { readOnly }),
  })
  if (route.kind === 'direct' && obs.entry.status === 'succeeded') st.counters.directSuccess++
  if (obs.refs?.source === 'text') st.counters.textReferences++
  delete st.cur.calls
  return endStep(s, obs, {
    ...routeEvent(route),
    ...recordedLlm(s),
    dispatch: dispatchEvent(calls, results, obs.refs),
  })
}

/**
 * A parked step, or a dispatch whose turn Core closed: the park intent with the turn still open
 * replays the calls; otherwise the approval decides whether the turn goes on, waits or ends.
 */
export async function resumeParkedStage(s: Scope, signal: AbortSignal): Promise<LoopStepOutcome> {
  const st = s.state
  const view = await s.ctx.turn.view()
  if (view && view.turnId === st.coreTurn) {
    st.stage = 'dispatch'
    return recoverStep(s, signal)
  }
  if (!view && st.stage === 'dispatch') {
    // Core closed the turn on a park the loop had not saved yet. Save it now: a restart after the
    // continuation opens must take this path again, not start a new turn.
    st.stage = 'parked'
    await save(
      s,
      (st.cur.calls ?? []).map((call) => call.invocationId),
    )
  }
  const resumed = view ? 'opened' : await s.ctx.input.resumeParked()
  if (resumed === 'opened') return continueApproval(s, signal)
  if (resumed === 'waiting') return { outcome: 'parked', reason: 'parked' }
  // Blocked, or nothing parked: the turn is over and no call of it may run again.
  await emitMetrics(s, resumed === 'blocked' ? 'blocked' : 'interrupted')
  st.stage = 'done'
  delete st.cur.calls
  await save(s)
  return resumed === 'blocked' ? { outcome: 'turn-ended', reason: 'blocked' } : { outcome: 'idle' }
}
