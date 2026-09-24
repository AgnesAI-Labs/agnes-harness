import type { Billing, ModelRecord, ThinkingLevel, UsageView } from '@agnes/protocol'
import type { CostLedger } from '../reduce/shapes.js'
import type { Event, Seq } from '../types.js'
import { applyCacheHealthEvent, cacheHealthView, initialCacheHealthState } from './cache-health.js'
import { computeSurface } from './surface.js'

export type UsageProjectionInput = {
  events: Iterable<Event>
  upto: Seq
  lane: string
  route: string
  model: Pick<ModelRecord, 'id' | 'contextWindow'> & Partial<Pick<ModelRecord, 'maxTokens'>>
  thinking: ThinkingLevel
  contextTokens: number
  autoCompact: boolean
}

/** Estimates context at the same bounded cut as a UI projection, without mutable session state. */
export function contextTokensAtCut(events: Iterable<Event>, lane: string, upto: Seq): number {
  const prefix = [...events].filter((event) => event.seq <= upto)
  let last: { seq: Seq; total: number } | undefined
  for (const event of prefix) {
    if ((event.lane ?? 'main') !== lane || event.type !== 'cost/ledger') continue
    const row = event.data as CostLedger
    if (
      row.purpose !== 'title' &&
      row.purpose !== 'approval-guardian' &&
      row.purpose !== 'media' &&
      !row.interrupted &&
      !row.adjustment
    )
      last = {
        seq: event.seq,
        total: row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite,
      }
  }
  let total = last?.total ?? 0
  for (const node of computeSurface(prefix, { lane })) {
    if (last && node.seq <= last.seq) continue
    const content = (node.event.data as { content?: Array<{ text?: string }> } | null)?.content ?? []
    for (const block of content) total += Math.ceil((block.text ?? '').length / 4)
  }
  return total
}

const emptyTotals = (): UsageView['totals'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
})

/**
 * Projects one bounded lane without consulting a provider or mutable session state. Credits and
 * dollars remain separate dimensions: only an explicit billing record can create a dollar total.
 */
export function projectUsage(input: UsageProjectionInput): UsageView {
  const totals = emptyTotals()
  const seen = new Set<string>()
  let usdMicros = 0
  let credits = 0
  let hasCredits = false
  let creditsComplete = true
  let creditsGateway = true
  let hasBilling = false
  let reasoningComplete = true
  let incompleteBilling = false
  let allGateway = true
  let allSubscription = true
  let forkBoundary: Seq | undefined
  let cacheHealth = initialCacheHealthState()

  for (const event of input.events) {
    if (event.seq > input.upto) continue
    cacheHealth = applyCacheHealthEvent(cacheHealth, event, input.lane)
    if (event.type === 'session/start' && (event.data as { parent?: { boundarySeq?: Seq } } | null)?.parent) {
      forkBoundary = (event.data as { parent: { boundarySeq: Seq } }).parent.boundarySeq
      Object.assign(totals, emptyTotals())
      seen.clear()
      usdMicros = 0
      credits = 0
      hasCredits = false
      creditsComplete = true
      creditsGateway = true
      hasBilling = false
      reasoningComplete = true
      incompleteBilling = false
      allGateway = true
      allSubscription = true
      continue
    }
    if ((event.lane ?? 'main') !== input.lane) continue
    if (event.type !== 'cost/ledger') continue
    const row = event.data as CostLedger
    if (seen.has(row.effectId)) continue
    seen.add(row.effectId)
    if (row.adjustment) {
      if (forkBoundary !== undefined && row.adjustment.of <= forkBoundary) continue
      if (hasCredits) credits += row.adjustment.delta
      if (hasBilling && row.adjustment.usdMicrosDelta !== undefined)
        usdMicros += row.adjustment.usdMicrosDelta
      continue
    }
    if (row.credits !== undefined) {
      hasCredits = true
      credits += row.credits
      creditsGateway &&= row.creditSource === 'gateway'
    } else creditsComplete = false
    totals.input += row.tokens.input
    totals.output += row.tokens.output
    totals.cacheRead += row.tokens.cacheRead
    totals.cacheWrite += row.tokens.cacheWrite
    totals.reasoning += row.tokens.reasoning ?? 0
    reasoningComplete &&= row.tokens.reasoning !== undefined
    if (row.billing) {
      hasBilling = true
      usdMicros += row.billing.usdMicros
      allGateway &&= row.billing.source === 'gateway'
      allSubscription &&= row.billing.subscription
    } else incompleteBilling = true
  }

  const cost: Billing | undefined = hasBilling
    ? {
        usdMicros: Math.max(0, usdMicros),
        source: allGateway && !incompleteBilling ? 'gateway' : 'estimated',
        subscription: allSubscription,
      }
    : undefined
  return {
    totals,
    ...(hasCredits
      ? {
          credits: {
            amount: Math.max(0, credits),
            source: creditsGateway && creditsComplete ? ('gateway' as const) : ('estimated' as const),
            complete: creditsComplete,
          },
        }
      : {}),
    reasoningComplete: seen.size > 0 && reasoningComplete,
    billingComplete: hasBilling && !incompleteBilling,
    ...(cost ? { cost } : {}),
    context: {
      source: 'estimated',
      tokens: input.contextTokens,
      window: input.model.contextWindow,
      autoCompact: input.autoCompact,
    },
    model: {
      route: input.route,
      id: input.model.id,
      thinking: input.thinking,
      ...(input.model.maxTokens ? { maxTokens: input.model.maxTokens } : {}),
    },
    ...(Object.keys(cacheHealthView(cacheHealth)).length > 0 ? { cache: cacheHealthView(cacheHealth) } : {}),
  }
}
