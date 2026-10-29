import type { LoopStepOutcome, LoopTurnView, ToolResult } from '@agnes/extension-api'
import { candidatesFor } from './candidates.js'
import { compileQuestions, criteriaCharsAt, decisionSurface, fitBudget } from './compile.js'
import { decodeAnswers } from './decode.js'
import { dispatchCalls, observeDispatch, replayCalls } from './dispatch.js'
import { checkAvailable, checkDuplicate } from './guards.js'
import { callJev, type JevDeps, type JevOutcome, type JevPayload } from './jev.js'
import { type Adoption, adoptCalls, noteFor, parseReply, type Reply } from './llm.js'
import { type LlmOutcome, requestLlm } from './model.js'
import {
  BUILTIN_TOOLS,
  decisionTools,
  intentFingerprint,
  outcomeUnknown,
  resultText,
  targetOf,
  turnToolNames,
} from './profile.js'
import { routeDecision } from './route.js'
import {
  boundContent,
  emitStep,
  endStep,
  finishTurn,
  pushPending,
  recordDecisionFailure,
  recordRefusal,
  refusalOf,
  type Scope,
  type StepEvent,
  save,
  snapshot,
} from './scope.js'
import { emitEvent } from './telemetry.js'
import {
  ANSWER,
  type CompiledQuestions,
  type JsonObject,
  type JsonValue,
  type LlmKind,
  type PendingCall,
  type ReferenceSource,
  type ResolvedTool,
  type Route,
} from './types.js'
import { digest16, errorCode, tail } from './util.js'
import { buildState, currentTurn } from './workspace.js'

const ANSWER_CHARS = 4000

const LLM_REFUSAL: Readonly<Record<Extract<Adoption, { kind: 'refuse' }>['code'], string>> = {
  NO_CALL: 'no_call',
  OPERATION_CHANGED: 'changed_op',
  CANNOT_BIND: 'cannot_bind',
  TRUNCATED: 'truncated',
  UNAVAILABLE: 'unavailable',
  INVALID_ARBITRATION: 'truncated',
}

const idPrefix = (s: Scope) => `jev:${s.state.idTurn}:${s.state.step}`

export function routeEvent(route: Route): StepEvent {
  return {
    route: route.kind,
    reason: route.reason,
    op: route.decision.op,
    bindingMode: route.decision.bindingMode,
  }
}

/**
 * The tools and questions of this step, and the Jev payload at a shrink level. The observed files and
 * directories of the workspace are offered as targets; from level 6 the questions carry clipped criteria
 * (same heads and options, so decoding always uses `compiled`).
 */
export function stepTools(
  s: Scope,
  view: LoopTurnView,
): { tools: ResolvedTool[]; compiled: CompiledQuestions; build(level: number): JevPayload | null } {
  const tools = decisionTools(view, s.state.toolNames)
  const candidates = candidatesFor(tools, view, s.state.workspace)
  const compiled = compileQuestions(tools, candidates)
  const surface = decisionSurface(compiled)
  const budget = { stateTokens: s.cfg.stateTokenBudget, requestTokens: s.cfg.requestTokenBudget }
  const clipped = new Map<number, CompiledQuestions>()
  const questionsAt = (level: number): CompiledQuestions => {
    const chars = criteriaCharsAt(level)
    if (chars === criteriaCharsAt(0)) return compiled
    let at = clipped.get(chars)
    if (at === undefined) {
      at = compileQuestions(tools, candidates, { criteriaChars: chars })
      clipped.set(chars, at)
    }
    return at
  }
  const build = (level: number): JevPayload | null => {
    const fit = fitBudget(questionsAt, (l) => buildState(s.state.workspace, l, surface), budget, level)
    return fit ? { state: fit.state, questions: fit.questions } : null
  }
  return { tools, compiled, build }
}

/**
 * Whether the tool a call names is read-only, from the turn's tool metadata; `undefined` when the view
 * does not list it. Only a tool without a profile needs it, so the view is read for those alone.
 */
export function readOnlyOf(
  view: LoopTurnView | null,
  toolNames: readonly string[],
  name: string,
): boolean | undefined {
  if (view === null) return undefined
  return decisionTools(view, toolNames).find((tool) => tool.name === name)?.readOnly
}

/**
 * The ports `callJev` and `resumeJev` need. Attempts are checkpointed once per id; a re-prepare at a
 * higher level updates the level in place. `sent()` counts the calls that reached the side-call port.
 */
export function jevDeps(s: Scope): { deps: JevDeps; sent(): number } {
  const st = s.state
  let sent = 0
  const deps: JevDeps = {
    sideCall: s.ctx.sideCall,
    delay: (ms, signal) => s.ctx.wait.delay(ms, signal),
    async recordAttempt(id, level) {
      if (!st.cur.jevAttempts.includes(id)) st.cur.jevAttempts.push(id)
      st.cur.level = level
      st.stage = 'decide'
      await save(s)
    },
    async emit(data) {
      if (data.status !== 'refused') sent++
      await emitEvent(s.ctx.events, st.counters, 'jev.decide', { step: st.step, ...data })
    },
  }
  return { deps, sent: () => sent }
}

/** Counts this step's side calls: every call after the first one is a retry. */
export function countJev(s: Scope, sent: number): void {
  s.state.counters.jevCalls += sent
  s.state.counters.jevRetries += Math.max(0, sent - 1)
}

/** Asks Jev for this step's decision and follows its route. */
export async function decideStep(
  s: Scope,
  view: LoopTurnView,
  signal: AbortSignal,
): Promise<LoopStepOutcome> {
  const st = s.state
  const { tools, compiled, build } = stepTools(s, view)
  const { deps, sent } = jevDeps(s)
  let outcome: JevOutcome
  try {
    outcome = await callJev(
      {
        route: s.cfg.jev.route,
        model: s.cfg.jev.model,
        deadlineMs: s.cfg.jev.deadlineMs,
        maxRetries: s.cfg.jev.maxRetries,
        idPrefix: idPrefix(s),
        usedAttempts: st.cur.jevAttempts.length,
        level: st.cur.level,
        build,
      },
      deps,
      signal,
    )
  } catch (error) {
    // A revoked execution scope ends the Jev call; the step ends as a cancellation.
    if (errorCode(error) !== 'E_CLOSED') throw error
    outcome = { kind: 'cancelled' }
  } finally {
    countJev(s, sent())
  }
  return decodeAndRoute(s, outcome, compiled, tools, signal)
}

/** Turns the Jev outcome into a recorded failure, or a route that the step then follows. */
export async function decodeAndRoute(
  s: Scope,
  outcome: JevOutcome,
  compiled: CompiledQuestions,
  tools: ResolvedTool[],
  signal: AbortSignal,
): Promise<LoopStepOutcome> {
  const st = s.state
  if (outcome.kind === 'cancelled') return finishTurn(s, 'aborted')
  if (outcome.kind === 'budget')
    return finishTurn(s, 'budget', { code: 'BUDGET_EXCEEDED', message: outcome.message })
  const failed = (code: 'MODEL_UNAVAILABLE' | 'INVALID_PROPOSAL', cause: string, message: string) =>
    endStep(s, recordDecisionFailure(s, code, cause, message), {
      route: 'decision_failed',
      reason: code,
      op: null,
      bindingMode: null,
    })
  if (outcome.kind === 'failed') return failed(outcome.code, outcome.cause, outcome.message)
  const decoded = decodeAnswers(outcome.answers, compiled)
  if (!decoded.ok) return failed('INVALID_PROPOSAL', 'answers', decoded.reason)
  const { decision } = decoded
  const turn = currentTurn(st.workspace)
  const route = routeDecision({
    decision,
    tool: decision.op === ANSWER ? null : (tools.find((tool) => tool.name === decision.op) ?? null),
    latest: turn[turn.length - 1] ?? null,
    turnHasAttempts: turn.length > 0,
    thresholds: s.cfg.thresholds,
  })
  st.cur.decision = route.decision
  st.cur.route = { kind: route.kind, reason: route.reason }
  if (route.kind !== 'direct') return llmStep(s, route, signal)
  st.counters.directSteps++
  // An observed batch is announced as one message, ids t0..tN; any other decision is one call.
  const calls = (route.decision.batch ?? [route.decision.args]).map(
    (args, i): PendingCall => ({
      invocationId: `${idPrefix(s)}:t${i}`,
      name: route.decision.op,
      args: args as JsonObject,
      announce: 'true',
    }),
  )
  if (route.decision.bindingMode === 'observed') st.counters.observedSteps++
  if (calls.length > 1) st.counters.batchSteps++
  return dispatchStep(s, calls, route, signal)
}

/** Counts a step's model attempts; every attempt after the step's first is a retry, including the first one sent after a restart. */
function countAttempts(s: Scope, kind: LlmKind, first: number, attempts: number): void {
  s.state.counters.llm[kind] += attempts
  s.state.counters.llm.retries += Math.max(0, attempts - (first === 0 ? 1 : 0))
}

/**
 * Sends the route's model request. `firstAttempt` and `note` resume a request after a restart: the
 * saved note is sent as it was, and the pending notes it already carries are not added again.
 */
export async function llmStep(
  s: Scope,
  route: Route,
  signal: AbortSignal,
  firstAttempt?: number,
  note?: string,
): Promise<LoopStepOutcome> {
  const st = s.state
  const kind = route.kind as LlmKind
  const turn = currentTurn(st.workspace)
  let text = note
  if (text === undefined) {
    text = noteFor({
      route,
      latest: turn[turn.length - 1] ?? null,
      toolNames: st.toolNames,
      pending: st.pendingNotes,
    })
    st.pendingNotes = []
  }
  const ctx = s.ctx
  const first = firstAttempt ?? st.cur.llm?.attempt ?? 0
  const sent: string[] = []
  const llmEvent = (attempts: number): JsonObject => ({
    kind,
    attempts,
    invocationIds: [...sent],
    droppedCalls: 0,
  })
  let r: LlmOutcome
  try {
    r = await requestLlm(
      {
        idPrefix: idPrefix(s),
        kind,
        note: text,
        firstAttempt: first,
        maxAttempts: s.cfg.llmMaxAttempts,
        toolNames: st.toolNames,
      },
      {
        prepareRequest: (options) => ctx.prepareRequest(options),
        estimateRequest: (request) => ctx.estimateRequest(request),
        model: ctx.model,
        turn: ctx.turn,
        wait: ctx.wait,
        ...(ctx.compaction ? { compaction: ctx.compaction } : {}),
        async save(llm, id) {
          // Attempts a restart already counted stay counted.
          const counted = st.cur.llm?.counted
          st.cur.llm = counted === undefined ? llm : { ...llm, counted }
          st.stage = 'llm'
          await save(s, [id])
        },
        async recomputeToolNames() {
          const view = await ctx.turn.view()
          if (!view) throw new Error('The Jev loop turn has no public view')
          const names = turnToolNames(view)
          if (names.join('\n') !== st.toolNames.join('\n')) st.toolNamesChanges++
          st.toolNames = names
          return [...names]
        },
      },
      signal,
      sent,
    )
  } catch (error) {
    // A cancelled backoff, a revoked scope or a refused admission: the attempts sent are still reported.
    if (sent.length > 0) {
      countAttempts(s, kind, first, sent.length)
      await emitStep(s, { ...routeEvent(route), llm: { ...llmEvent(sent.length), outcome: 'error' } })
    }
    throw error
  }
  // The note was committed with the first request; a restart never needs it again.
  if (st.cur.llm) delete st.cur.llm.note
  const attempts = r.kind === 'reply' || r.kind === 'failed' ? r.attempts : r.ids.length
  countAttempts(s, kind, first, attempts)
  const reported = llmEvent(attempts)
  if (r.kind === 'outcome') {
    // Compaction ended the turn; the attempts already sent are still reported.
    if (r.ids.length > 0) await emitStep(s, { ...routeEvent(route), llm: { ...reported, outcome: 'error' } })
    return r.outcome
  }
  if (r.kind === 'reply') return handleReply(s, route, parseReply(r.events), reported, signal)
  await emitStep(s, { ...routeEvent(route), llm: { ...reported, outcome: 'error' } })
  if (r.kind === 'aborted') return finishTurn(s, 'aborted')
  // NO_ATTEMPTS (a resumed step with no attempt left) ends the turn like any failed request.
  return finishTurn(s, 'error', { code: 'JEV_LOOP_MODEL_FAILED', message: `${r.code}: ${r.message}` })
}

/** Commits a plain-text answer, records a refused reply, or dispatches the adopted calls. */
export async function handleReply(
  s: Scope,
  route: Route,
  reply: Reply,
  llmEvent: JsonObject,
  signal: AbortSignal,
): Promise<LoopStepOutcome> {
  const st = s.state
  const { decision } = route
  const a = adoptCalls({ route: route.kind as LlmKind, op: decision.op, reply, toolNames: st.toolNames })
  if (a.kind === 'answer') {
    if (route.kind === 'arbitration') {
      if (decision.op === ANSWER) st.counters.arbitrationAgreed++
      else st.counters.arbitrationOverturned++
    }
    st.workspace.answer = tail(a.text, ANSWER_CHARS)
    st.stage = 'finish'
    st.endReason = 'completed'
    delete st.endError
    delete st.cur.calls
    await s.ctx.events.assistant({ content: a.content, stopReason: 'end_turn' }, snapshot(s))
    // Reported once the answer is committed: a restart before the commit replays the step.
    await emitStep(s, { ...routeEvent(route), llm: { ...llmEvent, outcome: 'text' } })
    return finishTurn(s, 'completed')
  }
  if (a.kind === 'refuse') {
    if (a.code === 'NO_CALL') st.counters.noCall++
    const obs = recordRefusal(s, {
      phase: decision.phase,
      op: decision.op,
      target: null,
      code: a.code,
      stage: 'llm',
      message: a.message,
    })
    return endStep(s, obs, {
      ...routeEvent(route),
      llm: { ...llmEvent, outcome: LLM_REFUSAL[a.code] },
      refusal: refusalOf(obs),
    })
  }
  st.counters.droppedCalls += a.dropped
  if (a.declined) st.counters.answerDeclined++
  if (route.kind === 'arbitration') {
    if (a.calls[0]?.name === decision.op) st.counters.arbitrationAgreed++
    else st.counters.arbitrationOverturned++
  }
  // Only the first call carries the content: a batch is announced as one message.
  const content = boundContent(reply.content)
  const calls = a.calls.map(
    (call, i): PendingCall => ({
      invocationId: `${idPrefix(s)}:t${i}`,
      name: call.name,
      args: call.args,
      announce: 'content',
      ...(i === 0 ? { content } : {}),
    }),
  )
  return dispatchStep(s, calls, route, signal, {
    llm: { ...llmEvent, outcome: 'call', droppedCalls: a.dropped },
  })
}

function argKeys(args: JsonValue): string[] {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args).sort() : []
}

/**
 * The `dispatch` part of a step event. `refs` is what the observation's references came from and how
 * many were extracted, before the view's caps (so it can exceed what the view keeps).
 */
export function dispatchEvent(
  calls: readonly PendingCall[],
  results: readonly (ToolResult | null)[],
  refs?: { source: ReferenceSource; count: number },
): JsonObject {
  return {
    invocationIds: calls.map((call) => call.invocationId),
    names: calls.map((call) => call.name),
    argKeys: calls.map((call) => argKeys(call.args)),
    argsDigest: digest16(calls.length === 1 ? (calls[0]?.args ?? null) : calls.map((call) => call.args)),
    announce: calls[0]?.announce ?? 'true',
    batch: calls.length > 1,
    results: results.map((result, i) => {
      if (result === null) return 'unknown'
      if (!result.isError) return 'ok'
      return resultText(result) === `${calls[i]?.name} was announced but did not run`
        ? 'not_started'
        : 'error'
    }),
    ...(refs === undefined ? {} : { refs: { source: refs.source, count: refs.count } }),
  }
}

/** The workspace targets of the calls: one label for one call, the list for a batch. */
function targetsOf(s: Scope, calls: readonly PendingCall[]): string[] {
  return calls.flatMap((call) => {
    const target = targetOf(call.name, call.args, s.cwd)
    return target === null ? [] : [target]
  })
}

/**
 * Announces and runs the calls (or, with `replay`, replays the recorded ones with the same ids),
 * then records one observation. `llm` is the model part of this step's event. A new dispatch first
 * passes the guards: its tools must still be offered, and it may not be a third run of the same
 * intent that observed the same thing twice.
 */
export async function dispatchStep(
  s: Scope,
  calls: PendingCall[],
  route: Route,
  signal: AbortSignal,
  options: { llm?: JsonObject; replay?: boolean } = {},
): Promise<LoopStepOutcome> {
  const st = s.state
  const { decision } = route
  // `binding` describes the calls that were dispatched: a batch Core narrowed to its first call reports one.
  const event = (dropped: number): StepEvent => ({
    ...routeEvent(route),
    ...(route.kind === 'direct'
      ? {
          binding: {
            mode: decision.bindingMode,
            targets: targetsOf(s, calls.slice(0, calls.length - dropped)),
            batch: calls.length - dropped,
          },
        }
      : {}),
    ...(options.llm
      ? { llm: { ...options.llm, droppedCalls: Number(options.llm.droppedCalls ?? 0) + dropped } }
      : {}),
  })
  const intent = intentFingerprint(calls)
  const op = calls[0]?.name ?? decision.op
  const refused = options.replay
    ? null
    : (checkAvailable(
        calls.map((call) => call.name),
        st.toolNames,
      ) ?? checkDuplicate(currentTurn(st.workspace), intent, op))
  if (refused) {
    if (refused.code === 'UNAVAILABLE') st.counters.unavailableRefusals++
    else st.counters.duplicateRefusals++
    const targets = targetsOf(s, calls)
    const obs = recordRefusal(s, {
      phase: decision.phase,
      op,
      target: calls.length > 1 ? targets : (targets[0] ?? null),
      code: refused.code,
      stage: 'dispatch',
      message: refused.message,
      intentFp: intent,
    })
    return endStep(s, obs, { ...event(0), refusal: refusalOf(obs) })
  }
  st.stage = 'dispatch'
  st.cur.calls = calls
  const deps = {
    tools: s.ctx.tools,
    effects: s.ctx.effects,
    async save(narrowed: PendingCall[]) {
      st.cur.calls = narrowed
      await save(
        s,
        narrowed.map((call) => call.invocationId),
      )
    },
  }
  let d: Awaited<ReturnType<typeof dispatchCalls>>
  try {
    d = await (options.replay ? replayCalls : dispatchCalls)(calls, deps, signal)
  } catch (error) {
    // A parked step is reported when its approval continues; any other throw ends the step here.
    if (errorCode(error) !== 'PARKED') await emitStep(s, event(0))
    throw error
  }
  if (d.kind === 'budget') {
    delete st.cur.calls
    await emitStep(s, event(0))
    return finishTurn(s, 'budget', { code: 'BUDGET_EXCEEDED', message: d.message })
  }
  const common = {
    phase: decision.phase,
    cwd: s.cwd,
    confidence: decision.confidence,
    escalated: route.kind === 'arbitration',
  }
  if (d.kind === 'refused') {
    // A refused fallback leaves the rest of the batch unrun.
    const dropped = calls.length - d.calls.length
    st.counters.droppedCalls += dropped
    const first = d.calls[0] ?? calls[0]
    const obs = recordRefusal(s, {
      phase: decision.phase,
      op: first?.name ?? decision.op,
      target: first ? targetOf(first.name, first.args, s.cwd) : null,
      code: d.code,
      stage: 'dispatch',
      message: d.message,
    })
    if (d.code === 'INTERNAL_RELATION') {
      st.internalErrors++
      if (st.internalErrors >= 2) {
        // The second one ends the turn; the step is still reported, as a terminal refusal.
        await emitStep(s, { ...event(dropped), refusal: { ...refusalOf(obs), recoverability: 'terminal' } })
        throw new Error(d.message)
      }
    }
    delete st.cur.calls
    return endStep(s, obs, { ...event(dropped), refusal: refusalOf(obs) })
  }
  if (d.kind === 'unknown') {
    const obs = outcomeUnknown({ ...common, calls: d.calls, code: 'TOOL_OUTCOME_UNKNOWN' })
    delete st.cur.calls
    return endStep(s, obs, {
      ...event(0),
      dispatch: dispatchEvent(
        d.calls,
        d.calls.map(() => null),
      ),
    })
  }
  if (d.batchNote) pushPending(s, d.batchNote)
  st.counters.droppedCalls += d.dropped
  const readOnly =
    d.calls.length === 1 &&
    d.calls[0] !== undefined &&
    !(BUILTIN_TOOLS as readonly string[]).includes(d.calls[0].name)
      ? readOnlyOf(await s.ctx.turn.view(), st.toolNames, d.calls[0].name)
      : undefined
  const obs = observeDispatch({
    ...common,
    calls: d.calls,
    results: d.results,
    ...(readOnly === undefined ? {} : { readOnly }),
  })
  if (route.kind === 'direct' && obs.entry.status === 'succeeded') st.counters.directSuccess++
  if (obs.refs?.source === 'text') st.counters.textReferences++
  delete st.cur.calls
  return endStep(s, obs, {
    ...event(d.dropped),
    dispatch: dispatchEvent(d.calls, d.results, obs.refs),
  })
}
