import { assertRuntimeRecord } from '@agnes/jev-runtime'
import {
  type EventEnvelope,
  type RuntimeIdentity,
  validateAgainst,
  validateEvent,
  validModelPriceQuote,
} from '@agnes/protocol'
import { RequestBody } from '@agnes/protocol/gen/model'
import {
  type AccountingWindow,
  type AttemptEvidence,
  accountLane,
  ComparisonError,
  type LaneAccounting,
  modelPriceMultiplier,
  pricingFromModelQuote,
  type Usage,
} from '@agnes/runtime-comparison'
import {
  accountingOwnerKey,
  type ComparisonPriceEvidence,
  languageUsage,
  projectComparisonModelCalls,
} from './comparison-model-calls.js'

import { resolveJevPriceEstimate } from './jev-pricing.js'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : undefined
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as ObjectValue)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

export interface ComparisonAccountingInput extends AccountingWindow {
  sessionId: string
  runtime: RuntimeIdentity
  /** Physical inherited prefix, independently proven by the tree reader; never a paging cursor. */
  inheritedThroughSeq?: number
  /** Authorized, unfiltered session prefix from seq 1, including history before afterSeq. */
  events: readonly EventEnvelope[]
  /** A reader that hit its own scan limit must report false even if available rows are contiguous. */
  complete?: boolean
}
export interface ComparisonAttemptProjection {
  events: ComparisonPriceEvidence[]
  complete: boolean
  issues: string[]
}
interface Attempt {
  start: ComparisonPriceEvidence
  turn?: unknown
  step?: unknown
  codec?: unknown
  invalid: boolean
  pricing?: unknown
  decision?: {
    backend: string
    endpoint: string
    requestedModel: string
    admittedAt: number
    quote?: unknown
  }
  costs: ObjectValue[]
  settled: ComparisonPriceEvidence[]
}

function usageFor(attempt: Attempt, value: unknown): Usage | undefined {
  if (attempt.codec === 'agnes-language-v1' || attempt.codec === 'agnes-language-v2')
    return languageUsage(value)
  if (attempt.codec !== 'systemone-json-v1') return undefined
  const usage = object(value)
  if (!usage) return undefined
  // SystemOne attests total input, not an uncached bucket. Keep its aggregate while
  // leaving cache splits unknown; reasoning remains an output subset when attested.
  return {
    ...(usage.input_tokens === undefined ? {} : { inputTotal: usage.input_tokens as number | null }),
    ...(usage.output_tokens === undefined ? {} : { output: usage.output_tokens as number | null }),
  }
}

/** The v2 endpoint is a transport address, not the provider catalogue's route identity. */
function languageRoute(call: ObjectValue, sessionId: string): string | null {
  if (call.backend !== 'agnes-provider') return null
  if (call.codec !== 'agnes-language-v2') return identity(call.endpoint) ? call.endpoint : null
  const input = object(call.input)
  const request = validateAgainst<import('@agnes/protocol').RequestBody>(RequestBody, input?.request)
  const snapshot = object(input?.providerRequest)
  const effective = validateAgainst<import('@agnes/protocol').RequestBody>(RequestBody, snapshot?.request)
  if (
    !request.ok ||
    !effective.ok ||
    snapshot?.codec !== 'agnes-provider-request-v1' ||
    snapshot.endpoint !== call.endpoint ||
    request.value.sessionKey !== sessionId ||
    request.value.model !== call.requestedModel ||
    stable({ ...effective.value, system: request.value.system }) !== stable(request.value)
  )
    return null
  return request.value.route
}

/**
 * Project durable owners only: Native inference effect IDs, or Jev request IDs + attempt IDs.
 * No assistant text, billing amount or synthetic token estimate is usage evidence.
 * Explicit Jev estimates may use current exact-route rates with separate provenance.
 * This is synchronous and fixes throughSeq before reading; later rows cannot change the window.
 */
export function projectComparisonAttemptEvidence(
  input: ComparisonAccountingInput,
): ComparisonAttemptProjection {
  const { afterSeq, throughSeq } = input
  const inherited = input.inheritedThroughSeq ?? 0
  if (!integer(inherited) || inherited > throughSeq)
    throw new ComparisonError('INVALID_WINDOW', 'Invalid inherited prefix')
  if (!integer(afterSeq) || !integer(throughSeq) || afterSeq > throughSeq)
    throw new ComparisonError('INVALID_WINDOW', 'Accounting requires an exact nonnegative committed prefix')
  // Validate the whole committed prefix, including inherited history. Corrupt/unsupported
  // history can hide request origins, so afterSeq excludes charges but does not waive integrity.
  const issues = new Set<string>()
  if (input.complete === false) issues.add('incomplete_reader')
  const rows = new Map<number, EventEnvelope>()
  const conflicting = new Set<number>()
  for (const row of input.events) {
    if (!integer(row.seq) || row.seq < 1) {
      issues.add('invalid_sequence')
      continue
    }
    if (row.seq > throughSeq) continue
    const prior = rows.get(row.seq)
    if (prior && stable(prior) !== stable(row)) conflicting.add(row.seq)
    else rows.set(row.seq, row)
  }
  if (conflicting.size > 0) issues.add('conflicting_sequence')
  for (let seq = 1; seq <= throughSeq; seq++)
    if (!rows.has(seq)) {
      issues.add('incomplete_prefix')
      break
    }
  const start = rows.get(inherited + 1)
  const session = object(start?.data)
  const runtime = session?.runtime ?? { id: 'native', version: '1' }
  if (
    !identity(input.sessionId) ||
    start?.type !== 'session/start' ||
    start.origin !== 'system' ||
    start.trust !== 'trusted' ||
    session?.key !== input.sessionId ||
    conflicting.has(inherited + 1) ||
    (inherited > 0 && object(session?.parent)?.boundarySeq !== inherited) ||
    stable(runtime) !== stable(input.runtime) ||
    input.runtime.version !== '1' ||
    !['native', 'jevloop'].includes(input.runtime.id)
  )
    return { events: [], complete: false, issues: [...issues, 'unverified_session_runtime'] }

  const attempts = new Map<string, Attempt>()
  const requests = new Map<string, Attempt>()
  const recordIds = new Set<string>()
  const conflictingRecordIds = new Set<string>()
  const recordOwners = new Map<string, Attempt[]>()
  const key = accountingOwnerKey
  const ordered = [...rows.values()].filter((row) => row.seq > inherited).sort((a, b) => a.seq - b.seq)
  const modelCalls = projectComparisonModelCalls(ordered, conflicting)
  for (const issue of modelCalls.issues) issues.add(issue)
  const add = (row: EventEnvelope, id: string, family: AttemptEvidence['family']): Attempt => {
    const attemptId = key(row.lane, id)
    const prior = attempts.get(attemptId)
    if (prior) {
      prior.invalid = true
      issues.add('conflicting_attempt_origin')
      return prior
    }
    const attempt: Attempt = {
      start: {
        seq: row.seq,
        originSeq: row.seq,
        attemptId,
        family,
        stage: 'started',
        ...(input.runtime.id === 'native' ? { purpose: 'inference' } : {}),
      },
      invalid: conflicting.has(row.seq),
      costs: [],
      settled: [],
    }
    attempts.set(attemptId, attempt)
    return attempt
  }
  for (const row of ordered) {
    if (row.seq > inherited + 1 && row.type === 'session/start') issues.add('conflicting_session_start')
    const projectionRow = ['effect/intent', 'effect/settled', 'cost/ledger'].includes(row.type)
    if (
      (projectionRow || row.type === 'runtime/record') &&
      (row.origin !== 'system' || row.trust !== 'trusted' || !validateEvent(row).ok)
    ) {
      issues.add('untrusted_accounting_source')
      continue
    }
    const data = object(row.data)
    // A per-call source owns usage; effect/cost rows remain budget projections. This also
    // handles a compaction effect with multiple segment/retry calls without charging twice.
    if (projectionRow && identity(data?.effectId) && modelCalls.parents.has(key(row.lane, data.effectId)))
      continue
    if (input.runtime.id === 'native') {
      if (row.type === 'effect/intent' && data?.kind === 'inference') {
        if (identity(data.effectId)) add(row, data.effectId, 'llm')
        else issues.add('invalid_native_attempt')
      } else if (row.type === 'cost/ledger' && data?.purpose === 'inference') {
        const attempt = identity(data.effectId) ? attempts.get(key(row.lane, data.effectId)) : undefined
        if (!attempt || data.adjustment !== undefined) issues.add('unbound_native_usage')
        else {
          attempt.invalid ||= conflicting.has(row.seq) || attempt.settled.length > 0
          attempt.costs.push(data)
        }
      } else if (row.type === 'effect/settled' && identity(data?.effectId)) {
        const attempt = attempts.get(key(row.lane, data.effectId))
        if (attempt) {
          attempt.invalid ||= conflicting.has(row.seq)
          if (!['ok', 'error', 'aborted', 'unknown'].includes(String(data.outcome))) {
            attempt.invalid = true
            issues.add('invalid_native_settlement')
          }
          // Core inference.ts creates fallback tokens when provider usage never arrives. Only
          // provider-usage-derived fields attest a real frame; creditSource=estimated alone does not.
          const attested = attempt.costs.filter(
            (cost) =>
              (typeof cost.credits === 'number' && Number.isFinite(cost.credits) && cost.credits >= 0) ||
              object(cost.billing) !== undefined ||
              object(cost.timing) !== undefined ||
              cost.creditSource === 'gateway',
          )
          if (attempt.costs.length > 1 || (attested.length === 1 && attempt.costs.length !== 1)) {
            attempt.invalid = true
            issues.add('conflicting_native_usage')
          }
          attempt.settled.push({
            ...attempt.start,
            seq: row.seq,
            stage: 'settled',
            outcome:
              data.outcome === 'ok'
                ? 'completed'
                : data.outcome === 'error'
                  ? 'failed'
                  : data.outcome === 'aborted'
                    ? 'cancelled'
                    : 'unknown',
            ...(identity(attested[0]?.model) ? { model: attested[0].model } : {}),
            observedModel: (object(attested[0]?.response)?.model ?? null) as string | null,
            billing: (attested.length === 1 ? (attested[0]?.billing ?? null) : null) as Exclude<
              AttemptEvidence['billing'],
              undefined
            >,
            usage:
              attested.length === 1
                ? (languageUsage({ type: 'usage', tokens: attested[0]?.tokens }) ?? null)
                : null,
            pricing: null,
          })
        }
      } else if (
        (row.type === 'cost/ledger' && data?.purpose !== 'inference') ||
        (row.type === 'effect/intent' &&
          ['compaction', 'media', 'approval-guardian'].includes(String(data?.kind)))
      ) {
        // Compaction can merge multiple segment/retry calls into one effect/cost. Other auxiliary
        // effects need their own model-dispatch contracts, not a guessed attempt count.
        issues.add('unsupported_native_model_accounting')
      }
      continue
    }
    if (row.type === 'cost/ledger' && data?.purpose !== 'inference')
      issues.add('unsupported_auxiliary_model_accounting')
    if (row.type !== 'runtime/record') continue // Host inference cost/ledger is a duplicate projection, never a second attempt.
    if (stable(data?.runtime) !== stable(input.runtime)) {
      issues.add('foreign_runtime_record')
      continue
    }
    const record = object(data?.record)
    if (!record || !identity(record.id)) {
      issues.add('invalid_runtime_record')
      continue
    }
    if (record.kind === 'model.requested' || record.kind === 'model.settled') {
      try {
        assertRuntimeRecord(record)
      } catch {
        const owner = identity(record.requested) ? requests.get(key(row.lane, record.requested)) : undefined
        if (owner) owner.invalid = true
        issues.add('invalid_model_record')
        continue
      }
    }
    const recordKey = key(row.lane, record.id)
    if (recordIds.has(recordKey)) {
      issues.add('conflicting_runtime_record_id')
      conflictingRecordIds.add(recordKey)
    }
    recordIds.add(recordKey)
    if (record.kind === 'model.requested') {
      const call = object(record.call)
      const family =
        call?.purpose === 'decision'
          ? 'jev'
          : ['parameters', 'arbitration', 'answer'].includes(String(call?.purpose))
            ? 'llm'
            : undefined
      if (!family || !identity(record.attempt) || !identity(record.turn) || record.version !== 1) {
        issues.add('invalid_jev_attempt')
        continue
      }
      const attempt = add(row, record.attempt, family)
      attempt.start.purpose = String(call?.purpose)
      attempt.start.route =
        family === 'jev' && identity(call?.backend)
          ? call.backend
          : call
            ? languageRoute(call, input.sessionId)
            : null
      attempt.start.model = identity(call?.requestedModel) ? call.requestedModel : null
      attempt.turn = record.turn
      attempt.step = record.step
      attempt.codec = call?.codec
      const persistedQuote = family === 'jev' ? call?.pricing : object(call?.input)?.pricing
      if (family === 'jev' && identity(call?.endpoint) && identity(call?.requestedModel)) {
        attempt.decision = {
          backend: String(call.backend),
          endpoint: call.endpoint,
          requestedModel: call.requestedModel,
          admittedAt: Date.parse(row.ts),
          quote: persistedQuote,
        }
        const estimate = resolveJevPriceEstimate(attempt.decision)
        if (estimate) attempt.start.priceBasis = estimate.basis
        attempt.pricing = estimate?.quote ?? null
      }
      if (family !== 'jev')
        attempt.pricing =
          validModelPriceQuote(persistedQuote) && persistedQuote.admittedAt <= Date.parse(row.ts)
            ? persistedQuote
            : null
      attempt.start.priceQuote =
        attempt.pricing == null
          ? null
          : (structuredClone(attempt.pricing) as NonNullable<ComparisonPriceEvidence['priceQuote']>)
      if (
        (family === 'jev' && attempt.codec !== 'systemone-json-v1') ||
        (family === 'llm' && attempt.codec !== 'agnes-language-v1' && attempt.codec !== 'agnes-language-v2')
      ) {
        attempt.invalid = true
        issues.add('unsupported_usage_codec')
      }
      const prior = requests.get(recordKey)
      if (prior) {
        prior.invalid = attempt.invalid = true
        issues.add('conflicting_requested_id')
      }
      requests.set(recordKey, attempt)
      recordOwners.set(recordKey, [...(recordOwners.get(recordKey) ?? []), attempt])
    } else if (record.kind === 'model.settled') {
      const attempt = identity(record.requested) ? requests.get(key(row.lane, record.requested)) : undefined
      if (
        !attempt ||
        !identity(record.attempt) ||
        attempt.start.attemptId !== key(row.lane, record.attempt) ||
        attempt.turn !== record.turn ||
        attempt.step !== record.step ||
        record.version !== 1
      ) {
        if (attempt) attempt.invalid = true
        issues.add('unbound_jev_settlement')
        continue
      }
      attempt.invalid ||= conflicting.has(row.seq)
      recordOwners.set(recordKey, [...(recordOwners.get(recordKey) ?? []), attempt])
      const settlement = object(record.settlement)
      const error = object(settlement?.error)
      const observedModel = (settlement?.observedModel ??
        object(object(settlement?.usage)?.response)?.model ??
        null) as string | null
      const estimate = attempt.decision
        ? resolveJevPriceEstimate({ ...attempt.decision, observedModel })
        : null
      const jevPricing = estimate
        ? {
            currency: estimate.quote.policy.currency,
            perMillion: structuredClone(estimate.quote.policy.perMillion),
            inputBasis: estimate.inputBasis,
            multiplier: modelPriceMultiplier(estimate.quote.policy, Date.parse(row.ts), {
              start: estimate.quote.admittedAt,
              end: Date.parse(row.ts),
            }),
          }
        : null
      attempt.settled.push({
        ...attempt.start,
        seq: row.seq,
        stage: 'settled',
        outcome: error
          ? error.code === 'ABORTED'
            ? 'cancelled'
            : 'failed'
          : settlement && Object.hasOwn(settlement, 'output')
            ? 'completed'
            : 'unknown',
        observedModel: (settlement?.observedModel ??
          object(object(settlement?.usage)?.response)?.model ??
          null) as string | null,
        usage: usageFor(attempt, settlement?.usage) ?? null,
        billing: (attempt.codec === 'agnes-language-v1' || attempt.codec === 'agnes-language-v2'
          ? (object(settlement?.usage)?.billing ?? null)
          : null) as Exclude<AttemptEvidence['billing'], undefined>,
        // Billing remains separate from the frozen historical estimate.
        ...(estimate ? { priceBasis: estimate.basis } : {}),
        pricing: attempt.decision
          ? jevPricing
          : pricingFromModelQuote(
              attempt.pricing,
              {
                route: attempt.start.route,
                model: attempt.start.model,
                observedModel: (settlement?.observedModel ??
                  object(object(settlement?.usage)?.response)?.model ??
                  null) as string | null,
              },
              Date.parse(row.ts),
            ),
      })
    }
  }
  for (const id of conflictingRecordIds)
    for (const attempt of recordOwners.get(id) ?? []) attempt.invalid = true
  const events = [...attempts.values()].flatMap((attempt) => [
    attempt.invalid ? { ...attempt.start, priceQuote: null } : attempt.start,
    ...attempt.settled.map((settled) =>
      attempt.invalid
        ? {
            ...settled,
            usage: null,
            billing: null,
            pricing: null,
            priceQuote: null,
            outcome: 'unknown' as const,
          }
        : settled,
    ),
  ])
  return {
    events: [...modelCalls.events, ...events].sort((a, b) => a.seq - b.seq),
    complete: issues.size === 0,
    issues: [...issues],
  }
}

/** Pure Host boundary: no session writer, provider request or ledger mutation. */
export function accountComparisonLane(input: ComparisonAccountingInput): LaneAccounting {
  const projection = projectComparisonAttemptEvidence(input)
  const accounting = accountLane(
    projection.events,
    { afterSeq: input.afterSeq, throughSeq: input.throughSeq },
    projection.complete,
  )
  return { ...accounting, issues: [...new Set([...projection.issues, ...accounting.issues])] }
}
