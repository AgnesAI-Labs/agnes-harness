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

const CACHE_INVALIDATION_CAUSE_LABEL: Record<'compaction' | 'system-changed' | 'history-changed', string> = {
  compaction: '压缩',
  'system-changed': '系统提示变化',
  'history-changed': '历史内容变化',
}

export function formatUsageReport(usage?: UsageView): string {
  if (!usage) return '会话用量尚未提供。'
  const t = usage.totals
  const reasoning =
    usage.reasoningComplete === true
      ? String(t.reasoning)
      : t.reasoning > 0
        ? `${t.reasoning}（已知部分）`
        : '未完整提供'
  const cost = usage.cost
    ? `${formatUsdMicros(usage.cost.usdMicros)}（${usage.cost.source === 'estimated' ? '估算' : '网关记录'}${usage.billingComplete === false ? '，部分记录缺失' : ''}）`
    : '未提供'
  const hitRate = usage.cache?.hitRate
  const invalidation = usage.cache?.lastInvalidation
  return [
    '会话累计用量（当前分支）',
    `输入 Token（不含缓存）：${t.input} · 输出 Token（含推理）：${t.output}`,
    `缓存读取：${t.cacheRead} · 缓存写入：${t.cacheWrite}`,
    `缓存命中率（累计）：${hitRate !== undefined ? `${(hitRate * 100).toFixed(1)}%` : '暂无数据'}`,
    ...(invalidation
      ? [
          `最近一次缓存失效：seq ${invalidation.seq} · 原因 ${CACHE_INVALIDATION_CAUSE_LABEL[invalidation.cause]} · 重新处理 ${invalidation.reprocessedTokens} token`,
        ]
      : []),
    `推理 Token（输出子集，不重复相加）：${reasoning}`,
    `累计美元费用：${cost}`,
    `累计额度：${usage.credits ? `${usage.credits.amount} credits（${usage.credits.source === 'estimated' ? '估算' : '网关记录'}${usage.credits.complete ? '' : '，部分记录缺失'}）` : '未提供'}`,
    `上下文估算：${usage.context.tokens} / ${usage.context.window} Token（${((usage.context.tokens / usage.context.window) * 100).toFixed(1)}%）`,
    '上下文不是累计消耗；窗口来自模型配置。',
    `模型：${usage.model.route}/${usage.model.id} · 思考：${usage.model.thinking}`,
    ...(usage.model.maxTokens ? [`最大输出上限：${usage.model.maxTokens} Token`] : []),
    `自动整理上下文：${usage.context.autoCompact ? '已启用' : '未启用'}`,
  ].join('\n')
}

export function formatContextBreakdown(nodes: UINode[]): string {
  const sections = nodes.filter(
    (n): n is Extract<UINode, { kind: 'context-sections' }> => n.kind === 'context-sections',
  )
  const latest = sections.at(-1)
  if (!latest) return '尚无上下文分段记录：本会话还没有发起过正式请求。'
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
    `上下文分段（截至 seq ${latest.seq}，共 ${total} token，估算）`,
    '  order  section                      source        tokens    share',
    ...rows,
  ]
  if (conflicts.length > 0) {
    lines.push('', `⚠ 发现 ${conflicts.length} 处贡献冲突（同一 key 被多方写入，后写者生效）：`)
    for (const c of conflicts) lines.push(`  - ${c.key}: ${c.ops.join(', ')}`)
  }
  return lines.join('\n')
}
