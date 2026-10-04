import { canonicalJson } from '@agnes/core'
import {
  type EventEnvelope,
  MODEL_CALL_EVENT,
  type ModelCallRecord,
  type ModelPriceQuote,
  readModelCall,
  validModelPriceQuote,
} from '@agnes/protocol'
import { type AttemptEvidence, pricingFromModelQuote, type Usage } from '@agnes/runtime-comparison'

/** Internal sanitized price provenance on the same canonical evidence; never provider request bodies. */
export interface ComparisonPriceEvidence extends AttemptEvidence {
  priceQuote?: ModelPriceQuote | null
  priceBasis?: 'recorded' | 'current'
}

export const accountingOwnerKey = (lane: string | undefined, id: string): string =>
  canonicalJson([lane ?? null, id])

/** Agnes reports disjoint input buckets; totals are derived only when every operand is known. */
export function languageUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const frame = value as { type?: string; tokens?: Record<string, number | null> }
  const tokens = frame.tokens
  if (frame.type !== 'usage' || !tokens || typeof tokens !== 'object') return undefined
  const sum = (values: (number | null | undefined)[]) => {
    if (!values.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return undefined
    const total = values.reduce<number>((a, b) => a + (b as number), 0)
    return Number.isSafeInteger(total) ? total : undefined
  }
  const inputTotal = sum([tokens.input, tokens.cacheRead, tokens.cacheWrite])
  const total = sum([inputTotal, tokens.output])
  return {
    ...(tokens.input === undefined ? {} : { inputUncached: tokens.input }),
    ...(tokens.cacheRead === undefined ? {} : { cacheRead: tokens.cacheRead }),
    ...(tokens.cacheWrite === undefined ? {} : { cacheWrite: tokens.cacheWrite }),
    ...(tokens.output === undefined ? {} : { output: tokens.output }),
    ...(tokens.reasoning === undefined ? {} : { reasoning: tokens.reasoning }),
    ...(inputTotal === undefined ? {} : { inputTotal }),
    ...(total === undefined ? {} : { total }),
  }
}

const attribution = (record: ModelCallRecord) =>
  canonicalJson([
    record.id,
    record.scope,
    record.purpose,
    record.parentEffectId,
    record.route,
    record.model,
    record.sourceTurn,
    record.sourceStep,
    record.pricing ?? null,
  ])

/** The caller has already authorized and validated the frozen session prefix. */
export function projectComparisonModelCalls(
  rows: readonly EventEnvelope[],
  conflicting: ReadonlySet<number>,
) {
  const issues = new Set<string>()
  const parents = new Set<string>()
  const calls = new Map<
    string,
    {
      record: ModelCallRecord
      start: ComparisonPriceEvidence
      settlements: ComparisonPriceEvidence[]
      invalid: boolean
      aliases: string[]
    }
  >()
  for (const row of rows) {
    if (row.type !== MODEL_CALL_EVENT) continue
    const record = readModelCall(row)
    if (!record) {
      issues.add('invalid_model_call_record')
      continue
    }
    const key = accountingOwnerKey(row.lane, record.id)
    if (record.stage === 'started') {
      const prior = calls.get(key)
      if (prior) {
        prior.invalid = true
        issues.add('conflicting_model_call_origin')
        continue
      }
      calls.set(key, {
        record,
        start: {
          seq: row.seq,
          originSeq: row.seq,
          attemptId: `provider-call:${key}`,
          family: 'llm',
          stage: 'started',
          purpose: record.purpose,
          route: record.route,
          model: record.model,
          priceQuote:
            validModelPriceQuote(record.pricing) && record.pricing.admittedAt <= Date.parse(row.ts)
              ? structuredClone(record.pricing)
              : null,
        },
        settlements: [],
        invalid: conflicting.has(row.seq),
        aliases: [record.parentEffectId, record.id].map((id) => accountingOwnerKey(row.lane, id)),
      })
      continue
    }
    const call = calls.get(key)
    if (!call || call.start.seq !== record.startedSeq || attribution(call.record) !== attribution(record)) {
      if (call) call.invalid = true
      issues.add('unbound_model_call_settlement')
      continue
    }
    call.invalid ||= conflicting.has(row.seq) || call.settlements.length > 0
    if (call.settlements.length > 0) issues.add('conflicting_model_call_settlement')
    call.settlements.push({
      ...call.start,
      seq: row.seq,
      stage: 'settled',
      outcome: record.outcome,
      observedModel: record.observedModel,
      usage: languageUsage(record.usage) ?? null,
      billing: record.usage?.billing ?? null,
      pricing: pricingFromModelQuote(record.pricing, record, Date.parse(row.ts)),
    })
  }
  const projections = new Map<string, EventEnvelope[]>()
  for (const row of rows) {
    if (!['effect/intent', 'effect/settled', 'cost/ledger'].includes(row.type)) continue
    const id = (row.data as { effectId?: unknown } | null)?.effectId
    if (typeof id !== 'string') continue
    const key = accountingOwnerKey(row.lane, id)
    const matches = projections.get(key) ?? []
    matches.push(row)
    projections.set(key, matches)
  }
  for (const call of calls.values()) {
    const aliases = call.aliases
    const mismatch = aliases.some((alias) =>
      (projections.get(alias) ?? []).some((row) => {
        const data = row.data as { kind?: unknown; purpose?: unknown }
        return (
          row.origin !== 'system' ||
          row.trust !== 'trusted' ||
          conflicting.has(row.seq) ||
          (row.type === 'effect/intent' && data.kind !== call.record.purpose) ||
          (row.type === 'cost/ledger' && data.purpose !== call.record.purpose)
        )
      }),
    )
    if (mismatch) {
      call.invalid = true
      issues.add('conflicting_model_call_owner')
    }
    // Conflicting usage cannot revive the same request through its legacy projection.
    // Only the original admitted identity claims aliases; rejected duplicates add none.
    if (!mismatch) for (const alias of aliases) parents.add(alias)
  }
  const events = [...calls.values()].flatMap((call) => [
    call.invalid ? { ...call.start, priceQuote: null } : call.start,
    ...call.settlements.map((settled) =>
      call.invalid
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
  return { events, parents, issues: [...issues] }
}
