import type { UsageView } from '@agnes/protocol'

/** What background refinement spent on the session: tokens, and credits and dollars when priced. */
export type RefinementShare = UsageView['totals'] & { credits?: number; usdMicros?: number }

// The generated type of the per-lane record is `{}`; the schema names the shape.
const lanes = (usage: UsageView): Record<string, RefinementShare> =>
  (usage.byLane ?? {}) as Record<string, RefinementShare>

/** The refinement lane's spend, or undefined while it has spent nothing. */
export function refinementShare(usage: UsageView): RefinementShare | undefined {
  const share = lanes(usage).refinement
  if (!share) return undefined
  const spent = share.input + share.output + share.cacheRead + share.cacheWrite + share.reasoning
  return spent > 0 || (share.credits ?? 0) > 0 || (share.usdMicros ?? 0) > 0 ? share : undefined
}

/**
 * The session's own usage: the view's totals count every lane, so the refinement lane's tokens,
 * credits and dollars are taken out here. They are shown on their own line, never as the cost of
 * the conversation. The lane's entry is removed from the result too, so the result is not taken out
 * of a second time if it is passed through again.
 *
 * The quality flags (`billingComplete`, `reasoningComplete`, `cost.source`, `credits.source` and
 * `credits.complete`) are kept as the view gave them. The view folds them over every lane and the
 * lanes do not carry their own, so a refinement call the provider gave no price for can still show
 * the conversation's figures as partial or estimated. That errs towards saying less than is known,
 * never towards hiding a gap.
 */
export function withoutRefinement(usage: UsageView): UsageView {
  const share = refinementShare(usage)
  if (!share) return usage
  const others = Object.entries(lanes(usage)).filter(([name]) => name !== 'refinement')
  const left = (total: number, part: number | undefined) => Math.max(0, total - (part ?? 0))
  const totals = {
    input: left(usage.totals.input, share.input),
    output: left(usage.totals.output, share.output),
    cacheRead: left(usage.totals.cacheRead, share.cacheRead),
    cacheWrite: left(usage.totals.cacheWrite, share.cacheWrite),
    reasoning: left(usage.totals.reasoning, share.reasoning),
  }
  const { cost, credits, byLane: _lanes, ...rest } = usage
  const remaining = Object.fromEntries(others)
  // A dollar or credit total that only the refinement lane contributed to is no total at all.
  const other = (field: 'usdMicros' | 'credits') => others.some(([, lane]) => (lane[field] ?? 0) > 0)
  return {
    ...rest,
    totals,
    ...(others.length > 0 ? { byLane: remaining as NonNullable<UsageView['byLane']> } : {}),
    ...(cost && (share.usdMicros === undefined || other('usdMicros') || cost.usdMicros > share.usdMicros)
      ? { cost: { ...cost, usdMicros: left(cost.usdMicros, share.usdMicros) } }
      : {}),
    ...(credits && (share.credits === undefined || other('credits') || credits.amount > share.credits)
      ? { credits: { ...credits, amount: left(credits.amount, share.credits) } }
      : {}),
  }
}
