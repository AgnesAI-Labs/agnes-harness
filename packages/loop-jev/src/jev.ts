// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import type { LoopSideCallPort, PreparedSideCall, SideCallResult, SideCallUsage } from '@agnes/extension-api'
import { estimateTokens } from './compile.js'
import type { JsonObject, JsonValue } from './types.js'
import { clip, digest16, errorCode } from './util.js'

export type JevPayload = { state: JsonObject; questions: JsonObject }

export type JevDeps = {
  sideCall: LoopSideCallPort | undefined
  delay(ms: number, signal: AbortSignal): Promise<void>
  /**
   * Called before a send, once per (id, level), so the caller can checkpoint stage=decide. The same
   * id comes again only after a re-prepare at a higher level: the caller then updates `cur.level` in
   * place and does not append the id to `jevAttempts` a second time. Side-call rows are counted from
   * the `jev.decide` events whose status is not `refused`, not from these calls.
   */
  recordAttempt(invocationId: string, level: number): Promise<void>
  /**
   * Receives one `jev.decide` payload after each call that returned a result. A throw is swallowed so
   * the paid result is still used, and is reported to `dropped` when given.
   */
  emit(data: JsonObject): Promise<void>
  dropped?(error: unknown): void
}

export type JevRequest = {
  route: string
  model: string
  deadlineMs: number
  maxRetries: number
  /** `jev:<idTurn>:<step>`; attempt `a` is sent as `${idPrefix}:d${a}`. */
  idPrefix: string
  /** Attempts already spent in this step; the next new attempt number. */
  usedAttempts: number
  level: number
  /** The payload shrunk to `level`, or `null` when it cannot fit. */
  build(level: number): JevPayload | null
}

export type JevOutcome =
  | { kind: 'ok'; answers: JsonValue; invocationId: string; level: number }
  | {
      kind: 'failed'
      code: 'MODEL_UNAVAILABLE' | 'INVALID_PROPOSAL'
      cause: string
      message: string
      invocationId: string | null
    }
  | { kind: 'cancelled' }
  /** The side call was refused because the turn's credit is spent: the turn ends on budget. */
  | { kind: 'budget'; message: string }

type Failed = Extract<JevOutcome, { kind: 'failed' }>
type Call = { prepared: PreparedSideCall; payload: JevPayload; level: number }
type Attempt = {
  port: LoopSideCallPort
  req: JevRequest
  deps: JevDeps
  signal: AbortSignal
  recorded: Set<string>
}

const LABEL = 'jev.decide'
const PREPARED_TOKEN_LIMIT = 60000
const MAX_WAIT_MS = 10000
const BACKOFF_MS = 500
const POLL_MS = 200
const CANCELLED: JevOutcome = { kind: 'cancelled' }

const failed = (
  code: Failed['code'],
  cause: string,
  message: string,
  invocationId: string | null,
): Failed => ({
  kind: 'failed',
  code,
  cause,
  message: clip(message, 200),
  invocationId,
})

function detailReason(error: unknown): string {
  const detail = (error as { detail?: { reason?: unknown } } | null)?.detail
  return typeof detail?.reason === 'string' ? detail.reason : 'unspecified'
}

/** Builds and prepares at `level`, shrinking further while the port's estimate is over the limit. */
async function prepare(a: Attempt, id: string, level: number): Promise<Call | Failed> {
  for (let at = level; ; at++) {
    const payload = a.req.build(at)
    if (payload === null)
      return failed('INVALID_PROPOSAL', 'BUDGET', 'the Jev request does not fit the token budget', null)
    let prepared: PreparedSideCall
    try {
      prepared = await a.port.prepare({
        label: LABEL,
        target: { route: a.req.route, model: a.req.model },
        payload: { state: payload.state, questions: payload.questions },
        output: 'json',
        deadlineMs: a.req.deadlineMs,
        invocationId: id,
      })
    } catch (error) {
      const code = errorCode(error)
      if (code === 'E_MODEL_UNKNOWN') {
        return failed(
          'MODEL_UNAVAILABLE',
          code,
          `the Jev route is not configured: route "${a.req.route}", model "${a.req.model}" (E_MODEL_UNKNOWN)`,
          null,
        )
      }
      if (code === 'E_ENVELOPE') {
        return failed(
          'INVALID_PROPOSAL',
          code,
          `the Jev request was refused before sending (E_ENVELOPE: ${detailReason(error)})`,
          null,
        )
      }
      throw error
    }
    if (prepared.estimate.inputTokens <= PREPARED_TOKEN_LIMIT) return { prepared, payload, level: at }
  }
}

function decideEvent(attempt: number, id: string, call: Call, result: SideCallResult): JsonObject {
  const r = result as Readonly<{
    status: string
    reason?: string
    code?: string
    retryable?: boolean
    retryAfterMs?: number
    latencyMs?: number
    usage?: SideCallUsage
  }>
  const { state, questions } = call.payload
  const usdMicros = r.usage?.billing?.usdMicros
  return {
    attempt,
    invocationId: id,
    status: String(r.status),
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    ...(r.code === undefined ? {} : { code: r.code }),
    ...(r.retryable === undefined ? {} : { retryable: r.retryable }),
    ...(r.retryAfterMs === undefined ? {} : { retryAfterMs: r.retryAfterMs }),
    ...(r.latencyMs === undefined ? {} : { latencyMs: r.latencyMs }),
    usage: {
      inputTokens: r.usage?.tokens.input ?? 0,
      credits: r.usage?.credits ?? 0,
      ...(usdMicros === undefined ? {} : { usdMicros }),
    },
    request: {
      headIds: Object.keys(questions),
      stateTokensEst: estimateTokens(state),
      requestTokensEst: estimateTokens({ state, questions }),
      preparedInputTokens: call.prepared.estimate.inputTokens,
      stateDigest: digest16(state),
      questionsDigest: digest16(questions),
    },
  }
}

async function emitDecide(deps: JevDeps, data: JsonObject): Promise<void> {
  try {
    await deps.emit(data)
  } catch (error) {
    deps.dropped?.(error)
  }
}

/** Sends `id` once, re-preparing a single time when the port reports the request frozen. */
async function send(
  a: Attempt,
  id: string,
  attempt: number,
  level: number,
): Promise<{ result: SideCallResult; level: number } | Failed> {
  let call = await prepare(a, id, level)
  for (let refrozen = false; ; refrozen = true) {
    if ('kind' in call) return call
    const key = `${id} ${call.level}`
    if (!a.recorded.has(key)) {
      await a.deps.recordAttempt(id, call.level)
      a.recorded.add(key)
    }
    try {
      const result = await a.port.invoke(call.prepared, a.signal)
      await emitDecide(a.deps, decideEvent(attempt, id, call, result))
      return { result, level: call.level }
    } catch (error) {
      if (errorCode(error) !== 'E_REQUEST_FROZEN') throw error
      if (refrozen)
        return failed(
          'MODEL_UNAVAILABLE',
          'E_REQUEST_FROZEN',
          'the Jev target changed while sending (E_REQUEST_FROZEN)',
          null,
        )
    }
    call = await prepare(a, id, call.level)
  }
}

/** Maps one result. `attempt` is also the number of retries already spent in this step. */
function classify(
  result: SideCallResult,
  id: string,
  attempt: number,
  level: number,
  maxRetries: number,
): JevOutcome | { kind: 'retry'; waitMs: number } {
  switch (result.status) {
    case 'ok':
      if (result.json === undefined)
        return failed('INVALID_PROPOSAL', 'no-json', 'Jev returned no JSON answers', id)
      return { kind: 'ok', answers: result.json, invocationId: id, level }
    case 'failed': {
      const { reason, code } = result
      if (reason === 'cancelled' || code === 'ABORTED') return CANCELLED
      const cause = code ?? reason
      if (reason === 'invalid-output' || code === 'FORMAT')
        return failed('INVALID_PROPOSAL', cause, `Jev returned unusable answers (${cause})`, id)
      if (code === 'RATE_LIMIT' && attempt < maxRetries) {
        const waitMs = result.retryAfterMs ?? BACKOFF_MS * 2 ** attempt
        if (waitMs <= MAX_WAIT_MS) return { kind: 'retry', waitMs }
      }
      return failed(
        'MODEL_UNAVAILABLE',
        cause,
        `the Jev call failed: ${reason}${code === undefined ? '' : ` (${code})`}`,
        id,
      )
    }
    case 'unknown':
      return failed(
        'MODEL_UNAVAILABLE',
        'interrupted',
        'the Jev call was interrupted before its outcome was recorded',
        id,
      )
    case 'refused':
      if (result.reason === 'budget') return { kind: 'budget', message: 'the Jev call was refused: budget' }
      return failed(
        'MODEL_UNAVAILABLE',
        `refused:${result.reason}`,
        `the Jev call was refused: ${result.reason}`,
        id,
      )
    default:
      return failed('MODEL_UNAVAILABLE', 'unrecognized', 'the Jev call ended with an unrecognized status', id)
  }
}

async function wait(a: Attempt, ms: number): Promise<boolean> {
  try {
    await a.deps.delay(ms, a.signal)
    return true
  } catch (error) {
    if (a.signal.aborted) return false
    throw error
  }
}

/** Settles a result, retrying a rate limit with the next attempt number. */
async function settle(
  a: Attempt,
  result: SideCallResult,
  id: string,
  attempt: number,
  level: number,
): Promise<JevOutcome> {
  const next = classify(result, id, attempt, level, a.req.maxRetries)
  if (next.kind !== 'retry') return next
  if (!(await wait(a, next.waitMs))) return CANCELLED
  return run(a, `${a.req.idPrefix}:d${attempt + 1}`, attempt + 1, level)
}

async function run(a: Attempt, id: string, attempt: number, level: number): Promise<JevOutcome> {
  if (a.signal.aborted) return CANCELLED
  const sent = await send(a, id, attempt, level)
  if ('kind' in sent) return sent
  return settle(a, sent.result, id, attempt, sent.level)
}

const noPort = () =>
  failed('MODEL_UNAVAILABLE', 'NO_SIDE_CALL', 'the host gives this loop no side-call port', null)

/** Asks Jev for one step's answers, retrying only a rate limit, within this step. */
export async function callJev(req: JevRequest, deps: JevDeps, signal: AbortSignal): Promise<JevOutcome> {
  if (deps.sideCall === undefined) return noPort()
  const a: Attempt = { port: deps.sideCall, req, deps, signal, recorded: new Set() }
  return run(a, `${req.idPrefix}:d${req.usedAttempts}`, req.usedAttempts, req.level)
}

/**
 * Picks up the step's last recorded attempt (`lastId`, attempt `usedAttempts - 1`) after a restart:
 * a finished record is used as is, an absent one is sent with the same id, and one still in flight
 * is polled until the Jev deadline.
 */
export async function resumeJev(
  req: JevRequest & { lastId: string },
  deps: JevDeps,
  signal: AbortSignal,
): Promise<JevOutcome> {
  if (deps.sideCall === undefined) return noPort()
  const a: Attempt = {
    port: deps.sideCall,
    req,
    deps,
    signal,
    recorded: new Set([`${req.lastId} ${req.level}`]),
  }
  const attempt = Math.max(0, req.usedAttempts - 1)
  let status = await a.port.status(req.lastId)
  for (let waited = 0; status.status === 'in-flight'; waited += POLL_MS) {
    if (waited >= req.deadlineMs) {
      return failed(
        'MODEL_UNAVAILABLE',
        'in-flight',
        `the Jev call was still in flight after ${req.deadlineMs} ms`,
        req.lastId,
      )
    }
    if (!(await wait(a, POLL_MS))) return CANCELLED
    status = await a.port.status(req.lastId)
  }
  if (status.status === 'finished') return settle(a, status.result, req.lastId, attempt, req.level)
  if (status.status === 'absent') return run(a, req.lastId, attempt, req.level)
  return failed('MODEL_UNAVAILABLE', 'unrecognized', 'the Jev call has an unrecognized status', req.lastId)
}
