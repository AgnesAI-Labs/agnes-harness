import type { UINode, UsageView } from '@agnes/protocol'
import { formatTokenCount, formatUsdMicros } from './format-usage.js'

/** Only formats daemon projection values; no client-side accounting or currency conversion. */
export function formatCallUsage(node: Extract<UINode, { kind: 'cost' }>): string {
  const amount = node.billing
    ? `${formatUsdMicros(node.billing.usdMicros)} (${node.billing.source})`
    : `credits: ${node.credits ?? 'unknown'} (${node.source})`
  const tokens = node.tokens
    ? `input ${formatTokenCount(node.tokens.input)} · output ${formatTokenCount(node.tokens.output)} · cache read/write ${node.tokens.cacheRead}/${node.tokens.cacheWrite} · reasoning ${node.tokens.reasoning ?? 'unknown'}`
    : 'token details unavailable'
  const timing = node.timing
    ? [
        ...(node.timing.ttftMs !== undefined ? [`first output ${node.timing.ttftMs}ms`] : []),
        ...(node.timing.durationMs !== undefined ? [`request ${node.timing.durationMs}ms`] : []),
      ].join(' · ')
    : ''
  return [
    `usage (${node.purpose ?? 'record'}): ${amount}`,
    tokens,
    timing,
    node.interrupted ? 'interrupted: usage may be incomplete or estimated' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function formatUsageReport(usage?: UsageView, locale = 'en'): string {
  if (!usage) return tt('usage.none', locale)
  const totals = usage.totals
  const reasoning =
    usage.reasoningComplete === true
      ? String(totals.reasoning)
      : totals.reasoning > 0
        ? tt('usage.reasoningPartial', locale, { value: totals.reasoning })
        : tt('usage.notFullyProvided', locale)
  const cost = usage.cost
    ? `${formatUsdMicros(usage.cost.usdMicros)}（${tt(usage.cost.source === 'estimated' ? 'usage.estimated' : 'usage.gateway', locale)}${usage.billingComplete === false ? tt('usage.partialMissing', locale) : ''}）`
    : tt('usage.notProvided', locale)
  const credits = usage.credits
    ? `${usage.credits.amount} credits（${tt(usage.credits.source === 'estimated' ? 'usage.estimated' : 'usage.gateway', locale)}${usage.credits.complete ? '' : tt('usage.partialMissing', locale)}）`
    : tt('usage.notProvided', locale)
  const hitRate = usage.cache?.hitRate
  const invalidation = usage.cache?.lastInvalidation
  return [
    tt('usage.rows.heading', locale),
    tt('usage.rows.tokens', locale, { input: totals.input, output: totals.output }),
    tt('usage.rows.cache', locale, { read: totals.cacheRead, write: totals.cacheWrite }),
    tt('usage.rows.hitRate', locale, {
      rate: hitRate !== undefined ? `${(hitRate * 100).toFixed(1)}%` : tt('usage.rows.hitRateNone', locale),
    }),
    ...(invalidation
      ? [
          tt('usage.rows.invalidation', locale, {
            seq: invalidation.seq,
            cause: tt(CACHE_INVALIDATION_CAUSE_KEYS[invalidation.cause], locale),
            tokens: invalidation.reprocessedTokens,
          }),
        ]
      : []),
    tt('usage.rows.reasoning', locale, { value: reasoning }),
    tt('usage.rows.cost', locale, { value: cost }),
    tt('usage.rows.credits', locale, { value: credits }),
    tt('usage.rows.contextEstimate', locale, {
      tokens: usage.context.tokens,
      window: usage.context.window,
      pct: ((usage.context.tokens / usage.context.window) * 100).toFixed(1),
    }),
    tt('usage.rows.contextNote', locale),
    tt('usage.rows.model', locale, {
      route: usage.model.route,
      id: usage.model.id,
      thinking: usage.model.thinking,
    }),
    ...(usage.model.maxTokens ? [tt('usage.rows.maxOutput', locale, { value: usage.model.maxTokens })] : []),
    tt('usage.rows.autoCompact', locale, {
      value: usage.context.autoCompact ? tt('usage.enabled2', locale) : tt('usage.disabled2', locale),
    }),
  ].join('\n')
}

export function formatContextBreakdown(nodes: UINode[], locale = 'en'): string {
  const sections = nodes.filter(
    (n): n is Extract<UINode, { kind: 'context-sections' }> => n.kind === 'context-sections',
  )
  const latest = sections.at(-1)
  if (!latest) return tt('usage.context.none', locale)
  const conflicts = nodes.filter(
    (n): n is Extract<UINode, { kind: 'contribute-conflict' }> =>
      n.kind === 'contribute-conflict' && n.seq >= latest.seq,
  )
  const total = latest.sections.reduce((sum, s) => sum + s.tokens, 0)
  const rows = [...latest.sections]
    .sort((a, b) => a.order - b.order)
    .map((s) => {
      const share = total > 0 ? ((s.tokens / total) * 100).toFixed(1) : '0.0'
      return `  ${String(s.order).padStart(3)}  ${s.id.padEnd(28)} ${s.source.padEnd(12)} ${String(s.tokens).padStart(7)} tok  ${share.padStart(5)}%`
    })
  const lines = [
    tt('usage.context.heading', locale, { seq: latest.seq, total }),
    '  order  section                      source        tokens    share',
    ...rows,
  ]
  if (conflicts.length > 0) {
    lines.push('', tt('usage.context.conflicts', locale, { count: conflicts.length }))
    for (const c of conflicts) lines.push(`  - ${c.key}: ${c.ops.join(', ')}`)
  }
  return lines.join('\n')
}
