import type { ComparisonAccountingTotal, ComparisonPriceDetail } from '@agnes/protocol'
import { accountLane, TOKEN_BUCKETS } from '@agnes/runtime-comparison'
import { type ComparisonAccountingInput, projectComparisonAttemptEvidence } from './comparison-accounting.js'

const unknown = (): ComparisonAccountingTotal => ({
  state: 'unknown',
  value: null,
  knownSubtotal: null,
  missing: 1,
})

/** Read-only projection of the same canonical owners used by aggregate accounting. */
export function projectComparisonPriceDetails(input: ComparisonAccountingInput) {
  const projection = projectComparisonAttemptEvidence(input)
  const whole = accountLane(projection.events, input, projection.complete)
  const evidenceComplete = projection.complete && whole.issues.length === 0
  const sourceIssues = [...new Set([...projection.issues, ...whole.issues])]
  const groups = new Map<string, typeof projection.events>()
  for (const event of projection.events) {
    if (event.originSeq <= input.afterSeq) continue
    const key = JSON.stringify([event.family, event.attemptId])
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  const entries: ComparisonPriceDetail[] = []
  for (const group of groups.values()) {
    const start = group.find((event) => event.stage === 'started')
    if (!start) continue
    const settlements = group.filter((event) => event.stage === 'settled')
    const settled = settlements.length === 1 ? settlements[0] : undefined
    const accounting = accountLane(group, input, evidenceComplete)
    const family = accounting[start.family]
    const invalid = accounting.issues.length > 0
    const quote = invalid ? null : (start.priceQuote ?? null)
    const pricing = invalid || !quote ? null : (settled?.pricing ?? null)
    const issues = new Set(accounting.issues)
    if (!evidenceComplete) issues.add('incomplete_evidence')
    if (settlements.length === 0) issues.add('pending')
    if (settlements.length > 1) issues.add('conflicting_settlement')
    if (!quote) issues.add('missing_quote')
    else if (quote.route !== start.route || quote.model !== start.model) issues.add('quote_binding_mismatch')
    else if (
      settled?.observedModel != null &&
      settled.observedModel !== quote.model &&
      pricing?.inputBasis !== 'inputTotal'
    )
      issues.add('observed_model_mismatch')
    else if (settled && pricing?.multiplier == null) issues.add('invalid_price_interval')
    const totalInput = pricing?.inputBasis === 'inputTotal'
    const bucketCosts = Object.fromEntries(
      [...TOKEN_BUCKETS, ...(totalInput ? (['inputTotal'] as const) : [])].map((bucket) => {
        if (totalInput && ['inputUncached', 'cacheRead', 'cacheWrite'].includes(bucket))
          return [bucket, unknown()]
        const tokens = family.tokens[bucket]
        const units = tokens.knownSubtotal
        const rate = pricing?.perMillion[bucket === 'inputTotal' ? 'inputUncached' : bucket]
        const multiplier = pricing?.multiplier
        if (units === null) issues.add('missing_usage')
        if (units !== null && units > 0 && rate == null) issues.add('missing_rate')
        if (units === null || multiplier == null || (units > 0 && rate == null)) return [bucket, unknown()]
        const amount = units === 0 ? 0 : ((units * (rate as number)) / 1_000_000) * multiplier
        if (!Number.isFinite(amount) || amount < 0) return [bucket, unknown()]
        return [
          bucket,
          { ...tokens, value: tokens.state === 'complete' ? amount : null, knownSubtotal: amount },
        ]
      }),
    ) as ComparisonPriceDetail['bucketCosts']
    const outcomes = family.outcomes
    const outcome =
      (['pending', 'completed', 'failed', 'cancelled', 'unknown'] as const).find(
        (value) => outcomes[value] > 0,
      ) ?? 'unknown'
    const metadata = (key: 'purpose' | 'route' | 'model' | 'observedModel') =>
      invalid ? null : (group.find((event) => event[key] != null)?.[key] ?? null)
    entries.push({
      attemptId: start.attemptId,
      family: start.family,
      purpose: metadata('purpose'),
      route: metadata('route'),
      model: metadata('model'),
      observedModel: metadata('observedModel'),
      originSeq: start.originSeq,
      settledSeq: settled?.seq ?? null,
      outcome,
      quote: quote ? structuredClone(quote) : null,
      ...(quote ? { priceBasis: start.priceBasis ?? ('recorded' as const) } : {}),
      multiplier: pricing?.multiplier ?? null,
      tokens: family.tokens,
      bucketCosts,
      estimate: quote ? (family.costs[quote.policy.currency] ?? unknown()) : unknown(),
      reportedBilling: invalid ? null : (settled?.billing ?? null),
      issues: [...issues],
    })
  }
  return {
    entries: entries.sort((a, b) => a.originSeq - b.originSeq),
    evidenceComplete,
    issues: sourceIssues,
  }
}
