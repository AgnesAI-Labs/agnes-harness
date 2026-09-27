import type { UINode } from '@agnes/protocol'

export type CostNode = Extract<UINode, { kind: 'cost' }>
const count = (n: number) => n.toLocaleString('en-US')
const compact = (n: number) =>
  n < 1000 ? String(n) : `${(n / (n >= 1e6 ? 1e6 : 1000)).toFixed(1)}${n >= 1e6 ? 'M' : 'K'}`
const usd = (n: number) => `$${(n / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.00')}`
const credits = (n: number) => n.toFixed(8).replace(/\.?0+$/, '')
const source = (value: 'gateway' | 'estimated') => (value === 'estimated' ? '估算' : '网关记录')
const time = (n: number) => (n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} 秒`)
type Rows = Array<[string, string]>
const purposes: Record<string, string> = {
  inference: '模型调用',
  compaction: '上下文整理',
  subagent: '子任务',
  verifier: '结果验证',
  media: '媒体',
  tool: '工具',
}

export function costSummary(node: CostNode): string {
  const parts = node.tokens
    ? [`输入 ${compact(node.tokens.input)}`, `输出 ${compact(node.tokens.output)}`]
    : []
  const amount = node.billing
    ? `${usd(node.billing.usdMicros)}（${source(node.billing.source)}）`
    : node.credits === undefined
      ? '费用未提供'
      : `${credits(node.credits)} credits（${source(node.source)}）`
  return [...parts, amount, ...(node.interrupted ? ['已中断'] : [])].join(' · ')
}

function tokenRows(tokens: NonNullable<CostNode['tokens']>): Rows {
  return [
    ['输入 Token（不含缓存）', count(tokens.input)],
    ['输出 Token（含推理）', count(tokens.output)],
    ['缓存读取 Token', count(tokens.cacheRead)],
    ['缓存写入 Token', count(tokens.cacheWrite)],
    ['推理 Token（输出的子集）', tokens.reasoning === undefined ? '未提供' : count(tokens.reasoning)],
  ]
}

export function costDetails(node: CostNode): Rows {
  return [
    [
      '记录范围',
      Object.hasOwn(purposes, node.purpose ?? '')
        ? (purposes[node.purpose ?? ''] ?? '单次费用记录')
        : '单次费用记录',
    ],
    ...(node.model ? [['模型', node.model] as [string, string]] : []),
    ...(node.tokens ? tokenRows(node.tokens) : [['Token 明细', '未提供'] as [string, string]]),
    ...(node.billing
      ? [['美元费用', `${usd(node.billing.usdMicros)} · ${source(node.billing.source)}`] as [string, string]]
      : []),
    [
      '额度',
      node.credits === undefined ? '未提供' : `${credits(node.credits)} credits · ${source(node.source)}`,
    ],
    ...(node.timing?.ttftMs !== undefined
      ? [['首次输出等待', time(node.timing.ttftMs)] as [string, string]]
      : []),
    ...(node.timing?.durationMs !== undefined
      ? [['模型请求耗时', time(node.timing.durationMs)] as [string, string]]
      : []),
    ...(node.interrupted ? [['状态', '已中断；用量可能不完整或包含估算'] as [string, string]] : []),
  ]
}
