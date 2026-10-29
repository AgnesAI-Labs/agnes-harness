import type { UINode } from '@agnes/protocol'
import { fallbackT, type Translate } from '../locales/index.js'

export type CostNode = Extract<UINode, { kind: 'cost' }>
const count = (n: number) => n.toLocaleString('en-US')
export const compact = (n: number) =>
  n < 1000 ? String(n) : `${(n / (n >= 1e6 ? 1e6 : 1000)).toFixed(1)}${n >= 1e6 ? 'M' : 'K'}`
export const usd = (n: number) => `$${(n / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.00')}`
const credits = (n: number) => n.toFixed(8).replace(/\.?0+$/, '')
const source = (value: 'gateway' | 'estimated', t: Translate) =>
  t(value === 'estimated' ? 'cost.source.estimated' : 'cost.source.gateway')
const time = (n: number, t: Translate) =>
  n < 1000 ? `${n} ms` : t('cost.time.s', { n: (n / 1000).toFixed(2) })
type Rows = Array<[string, string]>
const purposeKeys = new Map([
  ['inference', 'cost.purpose.inference'],
  ['title', 'cost.purpose.title'],
  ['compaction', 'cost.purpose.compaction'],
  ['subagent', 'cost.purpose.subagent'],
  ['verifier', 'cost.purpose.verifier'],
  ['media', 'cost.purpose.media'],
  ['tool', 'cost.purpose.tool'],
  ['side-call', 'cost.purpose.side-call'],
])

export function costSummary(node: CostNode, t: Translate = fallbackT): string {
  const parts = node.tokens
    ? [
        t('cost.summary.input', { n: compact(node.tokens.input) }),
        t('cost.summary.output', { n: compact(node.tokens.output) }),
      ]
    : []
  const amount = node.billing
    ? t('cost.billing.usd', { usd: usd(node.billing.usdMicros), source: source(node.billing.source, t) })
    : node.credits === undefined
      ? t('cost.summary.noBilling')
      : t('cost.summary.credits', { credits: credits(node.credits), source: source(node.source, t) })
  return [...parts, amount, ...(node.interrupted ? [t('cost.summary.interrupted')] : [])].join(' · ')
}

function tokenRows(tokens: NonNullable<CostNode['tokens']>, t: Translate): Rows {
  return [
    [t('cost.rows.tokensInNoCache'), count(tokens.input)],
    [t('cost.rows.tokensOutReasoning'), count(tokens.output)],
    [t('cost.rows.cacheRead'), count(tokens.cacheRead)],
    [t('cost.rows.cacheWrite'), count(tokens.cacheWrite)],
    [
      t('cost.rows.reasoning'),
      tokens.reasoning === undefined ? t('cost.rows.notProvided') : count(tokens.reasoning),
    ],
  ]
}

/** `money` lets a view that lines costs up print every amount with one precision. */
export function costDetails(
  node: CostNode,
  t: Translate = fallbackT,
  money: (usdMicros: number) => string = usd,
): Rows {
  const purpose = node.purpose ?? ''
  const purposeKey = purposeKeys.get(purpose)
  return [
    [t('cost.rows.range'), purposeKey === undefined ? t('cost.rows.singleRecord') : t(purposeKey)],
    ...(node.model ? [[t('cost.rows.model'), node.model] as [string, string]] : []),
    ...(node.tokens
      ? tokenRows(node.tokens, t)
      : [[t('cost.rows.tokenDetail'), t('cost.rows.notProvided')] as [string, string]]),
    ...(node.billing
      ? [
          [t('cost.rows.usd'), `${money(node.billing.usdMicros)} · ${source(node.billing.source, t)}`] as [
            string,
            string,
          ],
        ]
      : []),
    [
      t('cost.rows.credits'),
      node.credits === undefined
        ? t('cost.rows.notProvided')
        : `${credits(node.credits)} credits · ${source(node.source, t)}`,
    ],
    ...(
      [
        'providerCallMs',
        'prepareMs',
        'captureMs',
        'dispatchMs',
        'firstOutputMs',
        'outputMs',
        'finalizeMs',
      ] as const
    ).map((key): [string, string] => [
      t(`cost.rows.${key}`),
      node.timing?.[key] === undefined ? t('cost.rows.notProvided') : time(node.timing[key], t),
    ]),
    ...(node.timing?.ttftMs !== undefined
      ? [[t('cost.rows.ttft'), time(node.timing.ttftMs, t)] as [string, string]]
      : []),
    ...(node.timing?.durationMs !== undefined
      ? [[t('cost.rows.requestDuration'), time(node.timing.durationMs, t)] as [string, string]]
      : []),
    ...(node.interrupted
      ? [[t('cost.rows.status'), t('cost.rows.interruptedNote')] as [string, string]]
      : []),
  ]
}
