import type { LoopStepOutcome, ToolResult } from '@agnes/extension-api'
import { observeDispatch } from './dispatch.js'
import { type JevOutcome, resumeJev } from './jev.js'
import { parseReply } from './llm.js'
import { emitStep, endStep, finishTurn, recordRefusal, refusalOf, type Scope, save } from './scope.js'
import {
  countJev,
  decodeAndRoute,
  dispatchEvent,
  dispatchStep,
  handleReply,
  jevDeps,
  llmStep,
  routeEvent,
  stepTools,
} from './step.js'
import type { InferenceEvent, JsonObject, LlmKind, PendingCall, Route } from './types.js'
import { clip, errorCode } from './util.js'

type ErrorEvent = Extract<InferenceEvent, { type: 'error' }>

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

/** Counts model attempts the interrupted process sent but never counted. */
function countSent(s: Scope, kind: LlmKind, attempts: number, retries: number): void {
  s.state.counters.llm[kind] += attempts
  s.state.counters.llm.retries += retries
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
 */
async function recoverLlm(s: Scope, signal: AbortSignal): Promise<LoopStepOutcome> {
  const llm = s.state.cur.llm
  if (!llm) throw new Error('The interrupted Jev loop model request has no record')
  const route = savedRoute(s)
  const { kind, attempt: k } = llm
  const ids = llmIds(s, k)
  const receipt = await s.ctx.effects.status(`${idPrefix(s)}:m${k}`)
  if (receipt.status === 'not-sent') {
    // Only the first attempt carries the note; a later one finds it already committed.
    countSent(s, kind, k, k)
    return llmStep(s, route, signal, k, k === 0 ? (llm.note ?? '') : '')
  }
  delete llm.note
  const llmEvent: JsonObject = { kind, attempts: ids.length, invocationIds: ids, droppedCalls: 0 }
  if (receipt.status === 'may-have-sent') {
    countSent(s, kind, k + 1, k)
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
  if (error?.retryable && error.reason !== 'aborted' && k + 1 < s.cfg.llmMaxAttempts) {
    countSent(s, kind, k + 1, k + 1)
    return llmStep(s, route, signal, k + 1, '')
  }
  countSent(s, kind, k + 1, k)
  if (!error) return handleReply(s, route, parseReply(events), llmEvent, signal)
  await emitStep(s, { ...routeEvent(route), llm: { ...llmEvent, outcome: 'error' } })
  if (error.reason === 'aborted') return finishTurn(s, 'aborted')
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
    return s.ctx.events.finish('parked')
  }
  const route = savedRoute(s)
  const { decision } = route
  const obs = observeDispatch({
    phase: decision.phase,
    calls,
    results,
    cwd: s.cwd,
    confidence: decision.confidence,
    escalated: route.kind === 'arbitration',
  })
  if (route.kind === 'direct' && obs.entry.status === 'succeeded') st.counters.directSuccess++
  delete st.cur.calls
  return endStep(s, obs, { ...routeEvent(route), ...recordedLlm(s), dispatch: dispatchEvent(calls, results) })
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
  const resumed = view ? 'opened' : await s.ctx.input.resumeParked()
  if (resumed === 'opened') return continueApproval(s, signal)
  if (resumed === 'waiting') return { outcome: 'parked', reason: 'parked' }
  // Blocked, or nothing parked: no call of this turn may run again.
  st.stage = 'done'
  delete st.cur.calls
  await save(s)
  return resumed === 'blocked' ? { outcome: 'turn-ended', reason: 'blocked' } : { outcome: 'idle' }
}
