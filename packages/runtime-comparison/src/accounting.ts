import { ComparisonError, canonical } from './state.js'

export const TOKEN_BUCKETS = ['inputUncached', 'cacheRead', 'cacheWrite', 'output'] as const
export type TokenBucket = (typeof TOKEN_BUCKETS)[number]
export type Usage = Partial<Record<TokenBucket | 'reasoning' | 'inputTotal' | 'total', number | null>>
export interface Pricing {
  currency: string
  /** Prices for disjoint buckets, per million tokens. Missing and null are unknown, never zero. */
  perMillion: Partial<Record<TokenBucket, number | null>>
  multiplier: number | null
  /** Total-input pricing only when all input rates are equal; cache splits remain unknown. */
  inputBasis?: 'inputTotal'
}
export type AttemptOutcome = 'completed' | 'failed' | 'cancelled' | 'unknown'
export interface ReportedBilling {
  usdMicros: number
  source: 'gateway' | 'estimated'
  subscription: boolean
}
export interface OutcomeCounts {
  completed: number
  failed: number
  cancelled: number
  unknown: number
  pending: number
}
export interface PurposeAccounting {
  attempts: number
  outcomes: OutcomeCounts
}
export interface BillingSourceAccounting {
  attempts: number
  usdMicros: Total
  subscriptionAttempts: number
  nonSubscriptionAttempts: number
}
export interface BillingAccounting {
  gateway: BillingSourceAccounting
  estimated: BillingSourceAccounting
  missingAttempts: number
}
export interface AttemptEvidence {
  seq: number
  /** Stable real request/attempt identity, scoped by lane and family, never derived from content. */
  attemptId: string
  family: 'jev' | 'llm'
  originSeq: number
  stage: 'started' | 'settled'
  /** One observed provider-call, not a claim about hidden wire retries. Missing legacy metadata is unknown. */
  purpose?: string | null
  route?: string | null
  model?: string | null
  observedModel?: string | null
  outcome?: AttemptOutcome
  billing?: ReportedBilling | null
  usage?: Usage | null
  pricing?: Pricing | null
  priceBasis?: 'recorded' | 'current'
}
export interface AccountingWindow {
  afterSeq: number
  throughSeq: number
}
export interface AccountingReader {
  /** Scan exactly this committed prefix. Report missing pages, gaps or truncated scans as incomplete. */
  read(window: AccountingWindow): Promise<{ events: readonly AttemptEvidence[]; complete: boolean }>
}
export interface Total {
  state: 'complete' | 'partial' | 'unknown'
  value: number | null
  knownSubtotal: number | null
  missing: number
}
export interface FamilyAccounting {
  attempts: number
  tokens: Record<TokenBucket | 'reasoning' | 'inputTotal' | 'total', Total>
  costs: Record<string, Total>
  bucketCosts?: Record<string, Partial<Record<TokenBucket | 'inputTotal', Total>>>
  priceMultipliers?: number[]
  unpricedAttempts: number
  currentPriceAttempts?: number
  outcomes: OutcomeCounts
  byPurpose: Record<string, PurposeAccounting>
  /** Persisted provider amounts; independent of historical token-price costs and credits. */
  reportedBilling: BillingAccounting
}
export interface LaneAccounting extends AccountingWindow {
  state: 'complete' | 'partial' | 'unknown'
  jev: FamilyAccounting
  llm: FamilyAccounting
  totalCosts?: Record<string, Total>
  issues: string[]
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value)
function sameEvidence(left: unknown, right: unknown): boolean {
  try {
    return canonical(left) === canonical(right)
  } catch {
    return false
  }
}

function total(values: readonly (number | null)[], complete: boolean, integral = false): Total {
  const known = values.filter((value): value is number => value !== null)
  const sum = known.reduce((a, b) => a + b, 0)
  const valid = finite(sum) && (!integral || Number.isSafeInteger(sum))
  const missing = values.length - known.length + (complete ? 0 : 1)
  return {
    state: !valid || (known.length === 0 && missing > 0) ? 'unknown' : missing > 0 ? 'partial' : 'complete',
    value: valid && missing === 0 ? sum : null,
    knownSubtotal: valid && (known.length > 0 || missing === 0) ? sum : null,
    missing,
  }
}

/** Sum independently attested subtotals while preserving their missing evidence. */
export function aggregateAccountingTotals(
  values: readonly Total[],
  complete: boolean,
  integral = false,
): Total {
  const known = values.flatMap((value) => (value.knownSubtotal === null ? [] : [value.knownSubtotal]))
  const sum = known.reduce((left, right) => left + right, 0)
  const valid = finite(sum) && (!integral || Number.isSafeInteger(sum))
  const missing = values.reduce((count, value) => count + value.missing, complete ? 0 : 1)
  const all = valid && complete && values.every((value) => value.state === 'complete')
  return {
    state: all ? 'complete' : known.length ? 'partial' : 'unknown',
    value: all ? sum : null,
    knownSubtotal: valid && (known.length || !missing) ? sum : null,
    missing,
  }
}

/** Currency labels remain independent; unassigned prices cannot become another family's free usage. */
export function combineFamilyCosts(
  families: readonly FamilyAccounting[],
  complete: boolean,
): Record<string, Total> {
  return Object.fromEntries(
    [...new Set(families.flatMap((family) => Object.keys(family.costs)))].map((currency) => [
      currency,
      aggregateAccountingTotals(
        families.map(
          (family) =>
            family.costs[currency] ??
            (family.unpricedAttempts || (family.attempts > 0 && Object.keys(family.costs).length === 0)
              ? {
                  state: 'unknown',
                  value: null,
                  knownSubtotal: null,
                  missing: Math.max(1, family.unpricedAttempts),
                }
              : { state: 'complete', value: 0, knownSubtotal: 0, missing: 0 }),
        ),
        complete,
      ),
    ]),
  )
}
function validUsage(usage: Usage | null | undefined): Usage | undefined {
  if (usage === undefined || usage === null || typeof usage !== 'object' || Array.isArray(usage))
    return undefined
  if (Object.values(usage).some((value) => value !== null && !integer(value))) return undefined
  const normalized = { ...usage }
  const inputParts = [usage.inputUncached, usage.cacheRead, usage.cacheWrite]
  if (inputParts.every(integer)) {
    const sum = inputParts.reduce((a, b) => a + b, 0)
    if (!Number.isSafeInteger(sum) || (usage.inputTotal != null && usage.inputTotal !== sum)) return undefined
    normalized.inputTotal = sum
  }
  if (integer(normalized.inputTotal) && integer(usage.output)) {
    const sum = normalized.inputTotal + usage.output
    if (!Number.isSafeInteger(sum) || (usage.total != null && usage.total !== sum)) return undefined
    normalized.total = sum
  }
  if (integer(usage.reasoning) && integer(usage.output) && usage.reasoning > usage.output) return undefined
  return normalized
}
/** Synchronous projection owns a fixed prefix; later array growth cannot move its throughSeq boundary. */
export function accountLane(
  events: readonly AttemptEvidence[],
  window: AccountingWindow,
  complete: boolean,
): LaneAccounting {
  if (!integer(window.afterSeq) || !integer(window.throughSeq) || window.afterSeq > window.throughSeq)
    throw new ComparisonError('INVALID_WINDOW', 'Accounting requires an exact nonnegative committed prefix')
  const issues: string[] = []
  const sequences = new Map<number, AttemptEvidence>()
  const conflicts = new Set<number>()
  for (const event of events) {
    if (!integer(event.seq)) {
      issues.push('invalid_sequence')
      continue
    }
    if (event.seq <= window.afterSeq || event.seq > window.throughSeq) continue
    const previous = sequences.get(event.seq)
    if (previous !== undefined && !sameEvidence(previous, event)) conflicts.add(event.seq)
    else sequences.set(event.seq, structuredClone(event))
  }
  if (conflicts.size > 0) issues.push('conflicting_sequence')
  const attempts = new Map<
    string,
    { family: AttemptEvidence['family']; origin: number; events: AttemptEvidence[]; conflict: boolean }
  >()
  for (const event of sequences.values()) {
    if (
      !integer(event.originSeq) ||
      event.originSeq > event.seq ||
      typeof event.attemptId !== 'string' ||
      !event.attemptId ||
      !['jev', 'llm'].includes(event.family) ||
      !['started', 'settled'].includes(event.stage)
    ) {
      issues.push('invalid_attempt')
      continue
    }
    if (event.originSeq <= window.afterSeq) continue // Inherited history is outside this run's accounting window.
    const key = canonical([event.family, event.attemptId])
    const attempt = attempts.get(key) ?? {
      family: event.family,
      origin: event.originSeq,
      events: [],
      conflict: false,
    }
    attempt.conflict ||= conflicts.has(event.seq) || attempt.origin !== event.originSeq
    attempt.events.push(event)
    attempts.set(key, attempt)
  }
  const prepared = [...attempts.values()].map((attempt) => {
    const settlements = attempt.events.filter((event) => event.stage === 'settled')
    const evidence = settlements[0]
    const metadata = ['purpose', 'route', 'model', 'observedModel'] as const
    const malformed = attempt.events.some(
      (event) =>
        metadata.some((key) => {
          const value = event[key]
          return (
            value != null &&
            (typeof value !== 'string' ||
              !value.trim() ||
              value.length > 256 ||
              Array.from(value).some((character) => character.charCodeAt(0) < 32))
          )
        }) ||
        (event.outcome !== undefined &&
          (event.stage !== 'settled' ||
            !['completed', 'failed', 'cancelled', 'unknown'].includes(event.outcome))) ||
        (event.billing != null &&
          (event.stage !== 'settled' ||
            !integer(event.billing.usdMicros) ||
            !['gateway', 'estimated'].includes(event.billing.source) ||
            typeof event.billing.subscription !== 'boolean')),
    )
    const attributionConflict = metadata.some(
      (key) => new Set(attempt.events.map((event) => event[key]).filter((value) => value != null)).size > 1,
    )
    const contradictory =
      attempt.conflict ||
      attributionConflict ||
      settlements.some(
        (event) =>
          !sameEvidence(
            [event.usage ?? null, event.pricing ?? null, event.billing ?? null, event.outcome ?? 'unknown'],
            [
              evidence?.usage ?? null,
              evidence?.pricing ?? null,
              evidence?.billing ?? null,
              evidence?.outcome ?? 'unknown',
            ],
          ),
      )
    if (malformed) issues.push('invalid_attempt_metadata')
    if (contradictory) issues.push('conflicting_attempt')
    const invalid = malformed || contradictory
    const usage = invalid ? undefined : validUsage(evidence?.usage)
    if (!invalid && evidence?.usage != null && usage === undefined) issues.push('invalid_usage')
    return {
      family: attempt.family,
      purpose: invalid
        ? 'unknown'
        : (attempt.events.find((event) => event.purpose != null)?.purpose ?? 'unknown'),
      outcome: invalid
        ? ('unknown' as const)
        : evidence === undefined
          ? ('pending' as const)
          : (evidence.outcome ?? 'unknown'),
      usage,
      quote: invalid ? undefined : evidence?.pricing,
      priceBasis: invalid ? undefined : evidence?.priceBasis,
      billing: invalid ? undefined : evidence?.billing,
    }
  })
  const trusted = complete && issues.length === 0
  const emptyOutcomes = (): OutcomeCounts => ({
    completed: 0,
    failed: 0,
    cancelled: 0,
    unknown: 0,
    pending: 0,
  })
  const families = (family: AttemptEvidence['family']): FamilyAccounting => {
    const members = prepared.filter((attempt) => attempt.family === family)
    const tokens: Record<keyof FamilyAccounting['tokens'], (number | null)[]> = {
      inputUncached: [],
      cacheRead: [],
      cacheWrite: [],
      output: [],
      reasoning: [],
      inputTotal: [],
      total: [],
    }
    const costs = new Map<string, (number | null)[]>()
    const bucketValues = new Map<string, Partial<Record<TokenBucket | 'inputTotal', (number | null)[]>>[]>()
    const multipliers = new Set<number>()
    const outcomes = emptyOutcomes()
    const purposes = new Map<string, PurposeAccounting>()
    let unpricedAttempts = 0
    let missingQuotes = 0
    for (const attempt of members) {
      outcomes[attempt.outcome]++
      const purpose = purposes.get(attempt.purpose) ?? { attempts: 0, outcomes: emptyOutcomes() }
      purpose.attempts++
      purpose.outcomes[attempt.outcome]++
      purposes.set(attempt.purpose, purpose)
      for (const bucket of Object.keys(tokens) as (keyof typeof tokens)[])
        tokens[bucket].push(integer(attempt.usage?.[bucket]) ? attempt.usage[bucket] : null)
      const quote = attempt.quote
      if (quote == null || !quote.currency) {
        unpricedAttempts++
        missingQuotes++
        continue
      }
      const multiplier = quote.multiplier
      if (finite(multiplier)) multipliers.add(multiplier)
      const charged: Partial<Record<TokenBucket | 'inputTotal', (number | null)[]>> = {}
      let amount = 0
      let known = 0
      let missing = 0
      const totalInput =
        quote.inputBasis === 'inputTotal' &&
        family === 'jev' &&
        finite(quote.perMillion.inputUncached) &&
        quote.perMillion.cacheRead === quote.perMillion.inputUncached &&
        quote.perMillion.cacheWrite === quote.perMillion.inputUncached
      const buckets = totalInput ? (['inputTotal', 'output'] as const) : TOKEN_BUCKETS
      for (const bucket of buckets) {
        const units = attempt.usage?.[bucket]
        const rate = quote.perMillion[bucket === 'inputTotal' ? 'inputUncached' : bucket]
        // An attested zero bucket contributes zero without inventing its missing unit rate.
        if (!integer(units) || !finite(multiplier) || (units > 0 && !finite(rate))) {
          charged[bucket] = [null]
          missing++
          continue
        }
        const subtotal = units === 0 ? 0 : ((units * (rate as number)) / 1_000_000) * (multiplier as number)
        if (!finite(subtotal) || !finite(amount + subtotal)) {
          charged[bucket] = [null]
          missing++
          continue
        }
        amount += subtotal
        charged[bucket] = [subtotal]
        known++
      }
      if (missing > 0) unpricedAttempts++
      const values = costs.get(quote.currency) ?? []
      if (known > 0) values.push(amount)
      if (missing > 0) values.push(null)
      costs.set(quote.currency, values)
      const priorBuckets = bucketValues.get(quote.currency) ?? []
      priorBuckets.push(charged)
      bucketValues.set(quote.currency, priorBuckets)
    }
    const missingAttempts = members.filter((attempt) => attempt.billing == null).length
    const billingSource = (source: ReportedBilling['source']): BillingSourceAccounting => {
      const billings = members.flatMap((attempt) =>
        attempt.billing?.source === source ? [attempt.billing] : [],
      )
      return {
        attempts: billings.length,
        usdMicros: total(
          [
            ...billings.map((billing) => billing.usdMicros),
            ...Array<number | null>(missingAttempts).fill(null),
          ],
          trusted,
          true,
        ),
        subscriptionAttempts: billings.filter((billing) => billing.subscription).length,
        nonSubscriptionAttempts: billings.filter((billing) => !billing.subscription).length,
      }
    }
    return {
      attempts: members.length,
      tokens: Object.fromEntries(
        Object.entries(tokens).map(([key, values]) => [key, total(values, trusted, true)]),
      ) as FamilyAccounting['tokens'],
      costs: Object.fromEntries(
        [...costs].map(([currency, values]) => [
          currency,
          total([...values, ...Array<number | null>(missingQuotes).fill(null)], trusted),
        ]),
      ),
      bucketCosts: Object.fromEntries(
        [...bucketValues].map(([currency, rows]) => [
          currency,
          Object.fromEntries(
            [...new Set(rows.flatMap((row) => Object.keys(row)))].map((key) => [
              key,
              total(
                [
                  ...rows.flatMap((row) => row[key as TokenBucket | 'inputTotal'] ?? [null]),
                  ...Array<number | null>(missingQuotes).fill(null),
                ],
                trusted,
              ),
            ]),
          ),
        ]),
      ),
      priceMultipliers: [...multipliers].sort((left, right) => left - right),
      unpricedAttempts,
      currentPriceAttempts: members.filter(
        (attempt) => attempt.quote != null && attempt.priceBasis === 'current',
      ).length,
      outcomes,
      byPurpose: Object.fromEntries(purposes),
      reportedBilling: {
        gateway: billingSource('gateway'),
        estimated: billingSource('estimated'),
        missingAttempts,
      },
    }
  }
  const jev = families('jev')
  const llm = families('llm')
  const fields = [...Object.values(jev.tokens), ...Object.values(llm.tokens)]
  const known = [jev, llm].some(
    (family) =>
      family.attempts > 0 && Object.values(family.tokens).some((field) => field.state !== 'unknown'),
  )
  const isComplete =
    complete &&
    issues.length === 0 &&
    fields.every((field) => field.state === 'complete') &&
    jev.unpricedAttempts === 0 &&
    llm.unpricedAttempts === 0
  return {
    ...window,
    state: isComplete ? 'complete' : known ? 'partial' : 'unknown',
    jev,
    llm,
    totalCosts: combineFamilyCosts([llm, jev], trusted),
    issues: [...new Set(issues)],
  }
}
export async function readLaneAccounting(
  reader: AccountingReader,
  window: AccountingWindow,
): Promise<LaneAccounting> {
  const frozen = Object.freeze({ ...window })
  const result = await reader.read(frozen)
  return accountLane(result.events, frozen, result.complete)
}
