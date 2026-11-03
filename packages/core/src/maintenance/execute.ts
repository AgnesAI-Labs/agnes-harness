import { conservativeModelCredits } from '@agnes/core-child-control/child/credits'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError, type EventInput } from '@agnes/core-common/types'
import { armTimeout } from '@agnes/core-effects/effects/wrap'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import { MAINTENANCE_LANE } from '@agnes/core-ledger/reduce/state'
import type { CostLedger } from '@agnes/extension-api/seams'
import {
  AI_ERROR_CODES,
  type AiErrorCode,
  type InferenceEvent,
  type ModelRecord,
  type RequestBody,
  validateAgainst,
  validateEvent,
} from '@agnes/protocol'
import { RequestMessage as MessageSchema } from '@agnes/protocol/gen/model'
import { estimateTokens } from '../execution/model-tokens.js'
import { sysEvent } from '../step/events.js'
import type { SessionImpl } from '../step/session.js'
import { holdMaintenance, type MaintenanceHold, releaseMaintenance, settleMaintenance } from './budget.js'
import { claimMaintenance, maintenanceClosing } from './in-flight.js'

/** What a maintenance call records beside its effect intent, so a recovery can price it. */
export const MAINTENANCE_INTENT = 'x/core/maintenance-intent'
/** The row committed with a maintenance call's cost and settlement: how it ended and its text. */
export const MAINTENANCE_RESULT = 'x/core/maintenance-result'
/** The longest text a maintenance call keeps; a planner answers in far less. */
export const MAX_MAINTENANCE_TEXT = 65_536

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,100}$/u
const SENSITIVE = /(?:authorization|bearer|credential|secret|password|api[_-]?key|token|sk-[A-Za-z0-9])/iu
const DEADLINE_MS = { min: 100, max: 120_000 }
const MAX_SYSTEM_CHARS = 1_048_576

export type MaintenanceMessage = RequestBody['messages'][number]
export type MaintenanceRequest = Readonly<{
  runId: string
  system: string
  messages: readonly MaintenanceMessage[]
  maxOutputTokens: number
  deadlineMs: number
  target: Readonly<{ route: string; model: string }>
  /** A manual run the user agreed to pay an unknown price for; automatic planning never sets it. */
  allowUnpriced?: boolean
}>
export type MaintenanceUsage = CostLedger['tokens'] & { credits?: number }

/**
 * Why a call did not finish with a text. Refusals (`child-session`, `closing`, `duplicate`,
 * `target-unknown`, `unpriced`, `unavailable`, `budget`) write nothing and spend nothing.
 */
export type MaintenanceReason =
  | 'child-session'
  | 'closing'
  | 'duplicate'
  | 'target-unknown'
  | 'unpriced'
  | 'unavailable'
  | 'budget'
  | 'cancelled'
  | 'deadline'
  | 'provider'
  | 'no-usage'
  | 'invalid-output'

export type MaintenanceResult = Readonly<{
  outcome: 'ok' | 'error' | 'unknown'
  text?: string
  usage: MaintenanceUsage
  reason?: MaintenanceReason
  code?: AiErrorCode
  /** Whether the request may have reached the provider; a run whose call was not sent can be retried. */
  dispatch: 'not-sent' | 'may-have-sent'
}>

/** The effect id a maintenance run is recorded under; one run sends at most one call. */
export const maintenanceEffectId = (runId: string): string => `maintenance:${runId}`

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const digest = (value: unknown) => sha256Hex(canonicalJson(value))
const envelope = (message: string) => new CoreError('E_ENVELOPE', message, { reason: 'maintenance-request' })

const refused = (reason: MaintenanceReason): MaintenanceResult =>
  Object.freeze({ outcome: 'error', reason, usage: { ...ZERO }, dispatch: 'not-sent' })

/** A row on the maintenance lane, written by Core. */
const row = (s: SessionImpl, type: string, data: unknown, extra: Partial<EventInput> = {}) =>
  sysEvent({ actor: s.d.actor, lane: MAINTENANCE_LANE }, type, data, extra)

function checkRequest(req: MaintenanceRequest): void {
  const { runId, system, messages, maxOutputTokens, deadlineMs, target } = req ?? {}
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || SENSITIVE.test(runId))
    throw envelope('maintenance runId is invalid')
  if (typeof system !== 'string' || system.length > MAX_SYSTEM_CHARS)
    throw envelope('maintenance system prompt must be a string of at most 1 MiB')
  if (
    !Array.isArray(messages) ||
    messages.some(
      (message) =>
        !validateAgainst(MessageSchema, message).ok ||
        (message.role !== 'user' && message.role !== 'assistant') ||
        Object.hasOwn(message, 'toolCalls'),
    )
  )
    throw envelope('maintenance messages are user and assistant content with no tool calls')
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
    throw envelope('maintenance maxOutputTokens must be a positive integer')
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < DEADLINE_MS.min || deadlineMs > DEADLINE_MS.max)
    throw envelope('maintenance deadlineMs must be 100 to 120000')
  if (typeof target?.route !== 'string' || typeof target.model !== 'string')
    throw envelope('maintenance target names a route and a model')
}

/** Whether this run already has a call on the ledger, settled or not. */
async function recorded(s: SessionImpl, effectId: string): Promise<boolean> {
  if (s.state.pendingEffects.has(effectId)) return true
  const intents = await scanAll((q) => s.scan(q), {
    toSeq: s.lastSeq,
    lane: MAINTENANCE_LANE,
    type: 'effect/intent',
  })
  return intents.some((event) => (event.data as { effectId?: unknown } | null)?.effectId === effectId)
}

function catalogued(s: SessionImpl, target: MaintenanceRequest['target']): ModelRecord | undefined {
  try {
    return s.d.provider.models().find((item) => item.route === target.route && item.id === target.model)
  } catch {
    return undefined
  }
}

/** What the stream showed, read as it arrived. */
type Seen = {
  dispatched: boolean
  sent: boolean
  done: boolean
  text: string
  usage?: Extract<InferenceEvent, { type: 'usage' }>
  error?: { code: AiErrorCode }
}
type Cut = 'cancelled' | 'deadline' | 'closing'

/** Waits for `work` unless `signal` aborts first; an adapter that ignores its abort cannot hold a call. */
function raced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CoreError('E_CLOSED', 'maintenance call was cut'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

const codeOf = (value: unknown): AiErrorCode =>
  AI_ERROR_CODES.includes(value as AiErrorCode) ? (value as AiErrorCode) : 'TRANSPORT'

/** Reads the provider's stream to its end, or until the call is cut. Never throws. */
async function read(s: SessionImpl, wire: RequestBody, signal: AbortSignal, seen: Seen): Promise<void> {
  let iterator: AsyncIterator<InferenceEvent> | undefined
  try {
    const source = await raced(
      Promise.resolve().then(() => s.d.provider.infer(wire, { signal, toolNames: [], retry: false })),
      signal,
    )
    iterator = source[Symbol.asyncIterator]()
    // A provider does its work on the first read, so from here the request may have left.
    seen.dispatched = !signal.aborted
    for (;;) {
      const next = await raced(iterator.next(), signal)
      if (next.done) break
      const event = next.value
      // One read past the terminal lets a provider wrapper finish its own record; then stop.
      if (seen.done || seen.error) break
      if (event.type === 'sent') {
        const stamp = event.stamp.model
        if (seen.sent || stamp.id !== wire.model || stamp.route !== wire.route)
          seen.error = { code: 'CONTRACT_MISMATCH' }
        seen.sent = true
      } else if (event.type === 'error') {
        seen.error = { code: codeOf(event.code) }
        // An error before the sent stamp is a refusal: the request did not leave.
        if (!seen.sent) seen.dispatched = false
      } else if (!seen.sent) seen.error = { code: 'TRANSPORT' }
      else if (event.type === 'text_delta') seen.text += event.delta
      else if (event.type === 'usage') seen.usage = event
      else if (event.type === 'done') seen.done = true
    }
  } catch {
    if (!signal.aborted && !seen.done) seen.error ??= { code: 'TRANSPORT' }
  } finally {
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => undefined)
    } catch {
      /* provider cleanup cannot hold the settlement */
    }
  }
}

type Ending = Readonly<{
  outcome: MaintenanceResult['outcome']
  reason?: MaintenanceReason
  code?: AiErrorCode
  text?: string
}>

/** How a call ended. Only a close that cut a call already sent leaves its result unknown. */
function ending(seen: Seen, cut: Cut | undefined): Ending {
  if (seen.done && !seen.error) {
    if (!seen.usage) return { outcome: 'error', reason: 'no-usage' }
    if (seen.text.length > MAX_MAINTENANCE_TEXT) return { outcome: 'error', reason: 'invalid-output' }
    return { outcome: 'ok', text: seen.text }
  }
  if (cut === 'closing' && seen.dispatched) return { outcome: 'unknown', reason: 'closing' }
  if (cut) return { outcome: 'error', reason: cut }
  return { outcome: 'error', reason: 'provider', code: seen.error?.code ?? 'TRANSPORT' }
}

/** The cost row: the usage the provider reported, else the frozen estimate if it may have been sent. */
function costOf(
  seen: Seen,
  end: Ending,
  effectId: string,
  record: ModelRecord,
  inputTokens: number,
  projected: number | undefined,
): CostLedger {
  const usage = seen.usage
  const credits = usage?.credits ?? (seen.dispatched ? projected : 0)
  return {
    purpose: 'side-call',
    effectId,
    model: record.id,
    route: record.route,
    tokens:
      usage?.tokens ??
      (seen.dispatched ? { ...ZERO, input: inputTokens, output: estimateTokens(seen.text) } : { ...ZERO }),
    ...(credits === undefined ? {} : { credits }),
    creditSource: usage?.credits !== undefined ? (usage.creditSource ?? 'estimated') : 'estimated',
    ...(usage?.billing ? { billing: usage.billing } : {}),
    ...(end.outcome === 'ok' ? {} : { interrupted: true }),
  }
}

const recordable = (s: SessionImpl, rows: EventInput[]) =>
  rows.every(
    (event) =>
      validateEvent({
        lane: MAINTENANCE_LANE,
        v: 1,
        ...event,
        ts: new Date(0).toISOString(),
        id: '0'.repeat(26),
        seq: s.lastSeq + 1,
      }).ok,
  )

/**
 * Sends one maintenance call on the session's refinement lane. Nothing here needs a turn: the
 * intent, then one commit of cost, settlement and result, are written on the maintenance lane, which
 * the turn never waits for or settles. Pause and stop controls do not apply; applying a plan is a
 * separate step with its own checks. Refusals write nothing; once the intent is written the
 * settlement is always committed, even when the stream fails or the call is cut.
 */
export async function invokeMaintenance(
  s: SessionImpl,
  req: MaintenanceRequest,
  signal: AbortSignal,
  budgetTokens: number,
  unavailable: () => MaintenanceReason | undefined,
): Promise<MaintenanceResult> {
  checkRequest(req)
  const effectId = maintenanceEffectId(req.runId)
  const controller = new AbortController()
  let cut: Cut | undefined
  const stop = (why: Cut) => {
    cut ??= why
    controller.abort()
  }
  const claim = claimMaintenance(s, effectId, () => stop('closing'))
  if (claim === 'closing') return refused('closing')
  if (claim === 'running') return refused('duplicate')
  const onAbort = () => stop('cancelled')
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    // A caller that gave up before calling gets nothing written, sent or charged.
    if (signal.aborted) return refused('cancelled')
    const why = unavailable()
    if (why) return refused(why)
    if (await recorded(s, effectId)) return refused('duplicate')
    const record = catalogued(s, req.target)
    if (!record) return refused('target-unknown')
    const messages = structuredClone([...req.messages])
    const target = { route: record.route, model: record.id }
    const subject = { system: req.system, messages, maxOutputTokens: req.maxOutputTokens }
    const derivedHash = digest({ purpose: 'maintenance', target, ...subject, deadlineMs: req.deadlineMs })
    const wire: RequestBody = {
      kind: 'inference',
      sessionKey: s.key,
      slot: record.slot ?? 'primary',
      route: record.route,
      model: record.id,
      contractId: record.contract_id,
      derivedHash,
      system: req.system,
      messages,
      tools: [],
      sampling: { maxTokens: req.maxOutputTokens },
      timeoutMs: { firstToken: req.deadlineMs, total: req.deadlineMs },
    }
    const inputTokens = estimateTokens(canonicalJson({ system: req.system, messages }))
    let projected: number | undefined
    try {
      projected = conservativeModelCredits(inputTokens, req.maxOutputTokens, record.cost)
    } catch {
      projected = undefined
    }
    const hold = await holdMaintenance(s, {
      record,
      effectId,
      requestHash: derivedHash,
      inputTokens,
      maxOutputTokens: req.maxOutputTokens,
      projectedCredits: projected,
      budgetTokens,
      allowUnpriced: req.allowUnpriced === true,
    })
    if (hold.status === 'refused') return refused(hold.reason)
    if (hold.status === 'unbudgeted') projected = undefined
    if (controller.signal.aborted || maintenanceClosing(s)) {
      await releaseMaintenance(s, hold)
      return refused(cut === 'cancelled' ? 'cancelled' : 'closing')
    }
    try {
      await s.locked(() =>
        s.append([
          row(s, 'effect/intent', { effectId, kind: 'side-call', replay: 'never' }),
          row(
            s,
            MAINTENANCE_INTENT,
            {
              version: 1,
              runId: req.runId,
              effectId,
              route: record.route,
              model: record.id,
              inputTokens,
              projectedCredits: projected ?? null,
              maxOutputTokens: req.maxOutputTokens,
              deadlineMs: req.deadlineMs,
              requestHash: derivedHash,
            },
            { ignorable: true },
          ),
        ]),
      )
    } catch (error) {
      await releaseMaintenance(s, hold)
      throw error
    }
    return await dispatch(s, req, { effectId, wire, record, inputTokens, projected, hold }, controller, {
      cut: () => cut,
      deadline: () => stop('deadline'),
    })
  } finally {
    signal.removeEventListener('abort', onAbort)
    claim.release()
  }
}

async function dispatch(
  s: SessionImpl,
  req: MaintenanceRequest,
  call: {
    effectId: string
    wire: RequestBody
    record: ModelRecord
    inputTokens: number
    projected: number | undefined
    hold: MaintenanceHold
  },
  controller: AbortController,
  cuts: { cut: () => Cut | undefined; deadline: () => void },
): Promise<MaintenanceResult> {
  const { effectId, record, inputTokens, projected, hold } = call
  // A call that settles long after its intent still needs the writer lease, turn or no turn.
  const unhold = s.d.log.holdRenewal()
  const started = performance.now()
  const disarm = armTimeout(cuts.deadline, req.deadlineMs)
  const seen: Seen = { dispatched: false, sent: false, done: false, text: '' }
  try {
    await read(s, call.wire, controller.signal, seen)
    disarm()
    const build = (observed: Seen) => {
      const end = ending(observed, cuts.cut())
      const cost = costOf(observed, end, effectId, record, inputTokens, projected)
      const durationMs = Math.max(0, Math.round(performance.now() - started))
      const dispatched = observed.dispatched ? 'may-have-sent' : 'not-sent'
      const rows = [
        row(s, 'cost/ledger', cost),
        row(s, 'effect/settled', {
          effectId,
          outcome: end.outcome,
          ...(end.code ? { code: end.code } : {}),
          durationMs,
        }),
        row(
          s,
          MAINTENANCE_RESULT,
          {
            version: 1,
            runId: req.runId,
            effectId,
            outcome: end.outcome,
            dispatch: dispatched,
            ...(end.reason ? { reason: end.reason } : {}),
            ...(end.code ? { code: end.code } : {}),
            ...(end.text === undefined ? {} : { text: end.text }),
          },
          { ignorable: true },
        ),
      ]
      return { end, cost, rows, dispatched } as const
    }
    let built = build(seen)
    // Output the ledger cannot record as given is settled from Core's own values alone.
    if (!recordable(s, built.rows)) {
      s.d.logger.warn('maintenance output could not be recorded as given', { sessionKey: s.key })
      built = build({
        dispatched: seen.dispatched,
        sent: seen.sent,
        done: false,
        text: '',
        error: { code: 'TRANSPORT' },
      })
    }
    const committed = await s.locked(() => s.append(built.rows))
    const costSeq = committed.seqs[0]
    const { cost, end } = built
    if (costSeq !== undefined)
      await settleMaintenance(
        s,
        hold,
        cost.credits,
        costSeq,
        cost.creditSource === 'gateway' ? 'gateway' : 'estimated',
      )
    const billed = await s.d.runtime
      .billingRecord({ ...cost, sessionKey: s.key, lane: MAINTENANCE_LANE, turn: 0, step: 0 })
      .catch(() => false)
    if (!billed) s.d.logger.warn('maintenance billing record failed', { sessionKey: s.key, effectId })
    return Object.freeze({
      outcome: end.outcome,
      ...(end.text === undefined ? {} : { text: end.text }),
      usage: { ...cost.tokens, ...(cost.credits === undefined ? {} : { credits: cost.credits }) },
      ...(end.reason ? { reason: end.reason } : {}),
      ...(end.code ? { code: end.code } : {}),
      dispatch: built.dispatched,
    })
  } finally {
    disarm()
    unhold()
  }
}
