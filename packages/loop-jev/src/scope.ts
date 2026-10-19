import type { GenericLoopPorts, LoopCheckpoint, LoopEndReason, LoopStepOutcome } from '@agnes/extension-api'
import { checkNoProgress } from './guards.js'
import { runtimeNote } from './llm.js'
import { encodeState } from './state.js'
import { emitEvent } from './telemetry.js'
import type {
  AnnouncedContent,
  ErrorStage,
  JevLoopConfig,
  JevState,
  JsonObject,
  JsonValue,
  Observation,
  Phase,
  RouteKind,
} from './types.js'
import { clip, digest16, fingerprint, utf8Bytes } from './util.js'
import { currentTurn, recordStep } from './workspace.js'

/** What one step works on: the ports, the resolved configuration, the mutable state and the workspace root. */
export type Scope = { ctx: GenericLoopPorts; cfg: JevLoopConfig; state: JevState; cwd: string }

export type StepEvent = {
  route: RouteKind | 'decision_failed'
  reason: string | null
  op: string | null
  bindingMode: string | null
  llm?: JsonObject
  dispatch?: JsonObject
  binding?: JsonObject
  refusal?: JsonObject
}

const PENDING_NOTE_CHARS = 300
const PENDING_NOTES = 10
const CONTENT_MAX_BYTES = 8192
const ERROR_MESSAGE_CHARS = 200
const END_MESSAGE_CHARS = 500

/** The checkpoint of the current state. */
export function snapshot(s: Scope): LoopCheckpoint {
  return encodeState(s.state)
}

export async function save(s: Scope, ids?: readonly string[]): Promise<void> {
  await s.ctx.checkpoints.write(snapshot(s), ids?.length ? { invocationIds: ids } : undefined)
}

/** Queues one runtime observation line for the next model request; only the newest few are kept. */
export function pushPending(s: Scope, line: string): void {
  const pending = [...s.state.pendingNotes, clip(line, PENDING_NOTE_CHARS)]
  s.state.pendingNotes = pending.slice(-PENDING_NOTES)
}

function clipBytes(text: string, max: number): string {
  if (utf8Bytes(text) <= max) return text
  let low = 0
  let high = Math.min(text.length, max)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8Bytes(text.slice(0, mid)) <= max) low = mid
    else high = mid - 1
  }
  return text.slice(0, low)
}

/**
 * The model-written text and thinking announced with a call, within 8 KiB. Every pending call is
 * checkpointed with its content, so the same bounded content is announced and, after a restart,
 * replayed.
 */
export function boundContent(content: AnnouncedContent): AnnouncedContent {
  const bounded: AnnouncedContent = []
  let left = CONTENT_MAX_BYTES
  for (const block of content) {
    if (block.text === '') continue
    if (left <= 0) break
    const text = clipBytes(block.text, left)
    if (text === '') break
    bounded.push({ type: block.type, text })
    left -= utf8Bytes(text)
  }
  return bounded
}

export async function emitStep(s: Scope, event: StepEvent): Promise<void> {
  await emitEvent(s.ctx.events, s.state.counters, 'jev.step', { step: s.state.step, ...event })
}

/**
 * The `refusal` field of a step event, from the observation's error. The message can quote model
 * text, argument values or history, so the event carries only its digest; the text itself stays in
 * the checkpointed history and runtime note the next request needs.
 */
export function refusalOf(obs: Observation): JsonObject {
  const error = obs.entry.error
  if (!error) return {}
  return {
    code: error.code,
    stage: error.stage,
    recoverability: error.recoverability,
    digest: digest16(error.message),
  }
}

/**
 * Records the observation (its notes included), reports the step, and either ends the turn at the
 * no-progress limit or moves on to the next step.
 */
export async function endStep(s: Scope, obs: Observation | null, event: StepEvent): Promise<LoopStepOutcome> {
  const st = s.state
  if (obs) recordStep(st.workspace, obs)
  await emitStep(s, event)
  const limit = checkNoProgress(currentTurn(st.workspace))
  if (limit) {
    const last = limit.last
    const message = last
      ? `No progress: ${last.code} (${last.stage}): ${last.message}`
      : 'No progress: the last observations repeated'
    return finishTurn(s, 'error', { code: limit.code, message: clip(message, END_MESSAGE_CHARS) })
  }
  st.step += 1
  st.stage = 'decide'
  st.cur = { jevAttempts: [], level: 0 }
  await save(s)
  return { outcome: 'running', phase: 'decide' }
}

/** A step whose Jev call failed or whose answers were unusable: nothing ran. */
export function recordDecisionFailure(
  s: Scope,
  code: 'MODEL_UNAVAILABLE' | 'INVALID_PROPOSAL',
  cause: string,
  message: string,
): Observation {
  pushPending(s, runtimeNote(null, code, 'decision'))
  s.state.counters.decisionFailures[code]++
  return {
    entry: {
      phase: null,
      operation: null,
      target: null,
      status: 'failed',
      disposition: 'NOT_APPLIED',
      summary: 'decision() conf=n/a',
      error: {
        code,
        kind: code === 'MODEL_UNAVAILABLE' ? 'infrastructure' : 'proposal',
        stage: 'decision',
        recoverability: 'recoverable',
        message: clip(`${cause}: ${message}`, ERROR_MESSAGE_CHARS),
      },
      intentFp: null,
      observationFp: fingerprint(`failed:${code}`),
      dispatched: false,
    },
    notes: [],
  }
}

/** A proposal that was not applied: refused by the adoption rules or by Core, or held by the stop gate. */
export function recordRefusal(
  s: Scope,
  input: {
    phase: Phase | null
    op: string | null
    target: string | string[] | null
    code: string
    stage: ErrorStage
    message: string
    status?: 'refused' | 'held'
    /** The fingerprint of the refused calls; lets the no-progress limit see the same refusal repeat. */
    intentFp?: string
  },
): Observation {
  const status = input.status ?? 'refused'
  pushPending(s, runtimeNote(input.op, input.code, input.stage, input.message))
  const labels = input.target === null ? [] : Array.isArray(input.target) ? input.target : [input.target]
  const confidence = s.state.cur.decision?.confidence.toFixed(2) ?? 'n/a'
  const escalated = s.state.cur.route?.kind === 'arbitration' ? ' [escalated]' : ''
  return {
    entry: {
      phase: input.phase,
      operation: input.op,
      target: input.target,
      status,
      disposition: 'NOT_APPLIED',
      summary: `${input.op ?? 'decision'}(${labels.join(', ')}) conf=${confidence}${escalated}`,
      error: {
        code: input.code,
        kind: input.stage === 'llm' ? 'proposal' : 'policy',
        stage: input.stage,
        recoverability: 'recoverable',
        message: clip(input.message, ERROR_MESSAGE_CHARS),
      },
      intentFp: input.intentFp ?? null,
      observationFp: fingerprint(`${status}:${input.code}`),
      dispatched: false,
    },
    notes: [],
  }
}

/** The text of the newest history node, for the record of a held completion. */
function latestText(data: JsonValue | undefined): string {
  if (data === undefined) return ''
  const content =
    data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as JsonObject).content : null
  if (Array.isArray(content)) {
    const texts = content.flatMap((block) => {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) return []
      const { type, text } = block as JsonObject
      return type === 'text' && typeof text === 'string' ? [text] : []
    })
    if (texts.length > 0) return texts.join('\n')
  }
  return JSON.stringify(data)
}

/** Reports the turn's counters, best effort: a failed emit is counted, never thrown. */
export async function emitMetrics(s: Scope, reason: LoopEndReason): Promise<void> {
  const st = s.state
  await emitEvent(s.ctx.events, st.counters, 'jev.metrics', {
    ...st.counters,
    turn: st.idTurn,
    steps: st.step,
    toolNamesChanges: st.toolNamesChanges,
    endReason: reason,
  })
}

/**
 * Reports the turn's counters, checkpoints the ending and asks Core to end the turn. When the stop
 * gate keeps the turn open, the hold is recorded and the loop takes another step.
 */
export async function finishTurn(
  s: Scope,
  reason: LoopEndReason,
  error?: { code: string; message: string },
): Promise<LoopStepOutcome> {
  const st = s.state
  await emitMetrics(s, reason)
  st.stage = 'finish'
  st.endReason = reason
  if (error) st.endError = error
  else delete st.endError
  await save(s)
  const out = await s.ctx.events.finish(reason, error)
  if (out.outcome === 'running') {
    const view = await s.ctx.turn.view()
    const message = latestText(view?.history[view.history.length - 1]?.data)
    const obs = recordRefusal(s, {
      phase: null,
      op: 'ANSWER',
      target: null,
      code: 'STOP_GATE_HELD',
      stage: 'finish',
      status: 'held',
      message,
    })
    delete st.endReason
    return endStep(s, obs, {
      route: 'answer',
      reason: 'stop_gate_held',
      op: 'ANSWER',
      bindingMode: null,
      refusal: refusalOf(obs),
    })
  }
  st.stage = 'done'
  return out
}
