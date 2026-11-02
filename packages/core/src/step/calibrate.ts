import { sha256Hex } from '@agnes/core-common/request/hash'
import type { OpStateObj } from '@agnes/core-common/step/op-state'
import type { EventInput } from '@agnes/core-common/types'
import { withTimeout } from '@agnes/core-effects/effects/wrap'
import type { BudgetState } from '@agnes/core-ledger/reduce/shapes'
import { type CountResult, type RequestBody, validateAgainst } from '@agnes/protocol'
import { CountResult as CountResultSchema } from '@agnes/protocol/gen/model'
import { hookedAsk } from './approval-ask.js'
import { domainDecisionEvents, requestDomainDecision } from './domain-decision.js'
import type { SessionImpl, TurnEndReason } from './session.js'

/** How long a recount may take before the estimate is used instead. */
const COUNT_TIMEOUT_MS = 5000

export type CalibrationOutcome = {
  event?: EventInput
  deny?: { code: 'BUDGET_EXCEEDED'; message: string }
}

export type ProviderCountAttempt =
  | {
      kind: 'counted'
      count: { tokens: number; boundHash: string }
    }
  | { kind: 'unavailable'; reason: 'missing' | 'unsupported' | 'failed' }

/** One provider count attempt that admission and calibration may share without recounting. */
export async function attemptProviderCount(
  s: SessionImpl,
  wire: RequestBody,
  estimate: number,
): Promise<ProviderCountAttempt> {
  if (!s.d.provider.count) return { kind: 'unavailable', reason: 'missing' }
  let raw: unknown
  try {
    raw = await withTimeout(
      s.d.provider.count(wire, { signal: s.ac.signal }),
      COUNT_TIMEOUT_MS,
      'provider.count',
      s.ac.signal,
    )
  } catch (err) {
    await s.diag('budget-recount', {
      failed: true,
      estimate,
      message: err instanceof Error ? err.message : String(err),
    })
    return { kind: 'unavailable', reason: 'failed' }
  }
  const checked = validateAgainst<CountResult>(CountResultSchema, raw)
  if (!checked.ok) {
    await s.diag('budget-recount', {
      failed: true,
      estimate,
      message: 'provider.count returned an invalid count result',
    })
    return { kind: 'unavailable', reason: 'failed' }
  }
  const r = checked.value
  if (r.source === 'unsupported') return { kind: 'unavailable', reason: 'unsupported' }
  if (!Number.isSafeInteger(r.tokens) || r.tokens < 0 || r.boundHash !== wire.derivedHash) {
    await s.diag('budget-recount', {
      failed: true,
      estimate,
      message: 'provider.count returned an invalid count result',
    })
    return { kind: 'unavailable', reason: 'failed' }
  }
  return { kind: 'counted', count: { tokens: r.tokens, boundHash: r.boundHash } }
}

/**
 * The recount, after the request exists. The preflight can only estimate — it runs before anything
 * has been derived — so a preset that asked to be billed on a real count is answered here, where
 * there is a request to hand the provider. The row it produces is the same register cell the
 * preflight wrote, rewritten with the counted number and the hash it was bound to.
 *
 * Every failure keeps the estimate and lets the turn go on: an unreachable counter is a reason to
 * bill approximately, not a reason to refuse to answer.
 */
export async function countCalibration(
  s: SessionImpl,
  wire: RequestBody,
  estimate: number,
  prior?: ProviderCountAttempt,
  imageFallbackTokens?: number,
): Promise<CalibrationOutcome> {
  if (s.preset.budget.preflight !== 'count') return {}
  const attempt = prior ?? (await attemptProviderCount(s, wire, estimate))
  const resolved =
    attempt.kind === 'counted'
      ? { tokens: attempt.count.tokens, source: 'count' as const, boundHash: attempt.count.boundHash }
      : imageFallbackTokens === undefined
        ? undefined
        : { tokens: imageFallbackTokens, source: 'estimate' as const }
  if (!resolved) return {}
  // The preflight writes this register before every inference, so an empty cell here is a broken
  // counter rather than a first run. A default assembled out of the preset would invent a budget row
  // nobody wrote and hide the breakage, so the gap is recorded and the estimate is left standing.
  const cur = s.latest('budget.state') as BudgetState | undefined
  if (!cur) {
    await s.diag('invariant', { kind: 'budget-register-missing' })
    return {}
  }
  const event = s.ev(
    'budget.state',
    {
      ...cur,
      lastPreflight: {
        tokens: resolved.tokens,
        source: resolved.source,
        ...('boundHash' in resolved ? { boundHash: resolved.boundHash } : {}),
        at: new Date(s.d.clock()).toISOString(),
        // The ledger position as of just before this inference's own step/start — everything the
        // counted wire body reflects is at or before this seq, so a later derivation can tell how
        // much of the surface this number does *not* yet cover.
        seq: s.lastSeq,
      },
    },
    { register: 'budget.state' },
  )
  const cap = s.turnBudgetCap()
  const projected =
    cap === null
      ? undefined
      : await s.d.runtime.billingProjected({ tokensEstimate: resolved.tokens, model: wire.model })
  if (cap !== null && projected && projected.credits > cap)
    return {
      event,
      deny: {
        code: 'BUDGET_EXCEEDED',
        message: `${resolved.source === 'count' ? 'counted' : 'image-bounded'} request projected ${projected.credits} credits > cap ${cap} (${resolved.tokens} tokens; estimate ${estimate})`,
      },
    }
  return { event }
}

/**
 * Asks whether a request over the cap may be sent anyway. Both budget checks end here — the
 * preflight's estimate and the recount above — because the question and the rows that answer it are
 * the same either way, and two spellings of it would drift into two different records of the same
 * decision.
 *
 * `events` are rows the caller has to write in whichever transaction this takes, rather than in a
 * bare append of their own: the recount's `budget.state` is derived from one version of the program
 * counter, and writing it outside the transaction that reads that version gives up the
 * compare-and-set every other phase edge is guarded by.
 */
export async function quoteBudget(
  s: SessionImpl,
  summary: string,
  extra: { events?: EventInput[] } = {},
): Promise<'ok' | { reason: TurnEndReason }> {
  const op = s.op() as OpStateObj
  const events = extra.events ?? []
  const requestId = s.d.ids.requestId()
  const asked = {
    requestId,
    kind: 'budget' as const,
    summary,
    risk: 'budget' as const,
    bindingHash: '',
    deadline: new Date(s.d.clock() + s.preset.approval.timeoutMs).toISOString(),
  }
  // The payload describes "any request for human approval": this ask has no tool call behind it,
  // so `tool` names the approval's own kind and `argv` carries nothing.
  const { asked: finalAsked, rewrite } = await hookedAsk(s, asked.kind, null, asked)
  const review = await requestDomainDecision(
    s,
    'budget',
    `${op.meta.turn}:${op.step + 1}:${sha256Hex(summary)}`,
    {
      turn: op.meta.turn,
      step: op.step + 1,
      triggerSeq: op.meta.triggerSeq,
      cap: s.turnBudgetCap(),
      creditsUsed: s.state.creditsUsed,
      risk: finalAsked.risk,
      ...(rewrite ? { rewrite } : {}),
    },
    {
      ...finalAsked,
      sessionKey: s.key,
      stepId: `${op.meta.turn}/${op.step + 1}`,
      actor: s.d.actor,
      taint: op.taint || s.laneTaint(),
      scope: s.key,
    },
    s.ac.signal,
  )
  if (review.park && review.pending) {
    await s.endTurn('parked', {
      events: [...events, review.park],
    })
    return { reason: 'parked' }
  }
  if (review.park)
    await s.decisions.withdraw(
      review.snapshot.handle,
      review.source,
      (review.park.data as { waitEndedBy: string }).waitEndedBy,
    )
  await s.locked(async () => {
    const rows = [...events, ...domainDecisionEvents(s, review.snapshot, review.source)]
    if (rows.length) await s.d.log.append(rows)
  })
  if (
    review.snapshot.result?.reason !== 'answered' ||
    review.snapshot.invalidation ||
    !review.snapshot.result.response.option.startsWith('allowed')
  ) {
    // An interrupt reaches the approval seam as a refusal, because that is how it fails closed.
    // The turn still ended because someone stopped it, not because it ran out of credit, and the
    // ledger has to say which.
    const reason = s.ac.signal.aborted ? 'aborted' : 'budget'
    await s.endTurn(reason)
    return { reason }
  }
  return 'ok'
}
