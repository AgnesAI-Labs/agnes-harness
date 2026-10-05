import type {
  ComparisonAccountingFamily,
  ComparisonAccountingTotal,
  ComparisonMetricsResult,
} from '@agnes/protocol'
import { renderComparisonPrepared } from './comparison-prepared.js'

type Summary = NonNullable<ComparisonMetricsResult['summary']>
type SummaryLane = Summary['lanes'][number]
type Side = 'left' | 'right'

const SIDES: readonly Side[] = ['left', 'right']

const purposeLabels: Record<string, string> = {
  inference: '原生推理',
  decision: '决策',
  parameters: '参数生成',
  arbitration: '仲裁',
  answer: '回答',
  compaction: '压缩摘要',
  title: '会话标题',
  media: '媒体',
  unknown: '未知用途',
}

const purposeOrder = [
  'parameters',
  'arbitration',
  'answer',
  'inference',
  'decision',
  'compaction',
  'title',
  'media',
  'unknown',
] as const

const terminalLabels: Record<SummaryLane['terminalCause'], string> = {
  finished: '已完成',
  cancelled: '已取消',
  failed: '失败',
  unknown: '结束原因未知',
}

const rows = [
  { key: 'status', label: '状态' },
  { key: 'elapsed', label: '已确认累计耗时' },
  { key: 'llm-uncached', label: 'LLM 输入 Token（未缓存）' },
  { key: 'llm-cache', label: 'LLM 缓存读 Token' },
  { key: 'llm-output', label: 'LLM 输出 Token' },
  { key: 'llm-cost', label: 'LLM 估算费用' },
  { key: 'jev-input', label: 'Jev 决策输入 Token' },
  { key: 'jev-output', label: 'Jev 决策输出 Token' },
  { key: 'jev-cost', label: 'Jev 决策估算费用' },
  { key: 'cost', label: '合计估算费用' },
  { key: 'calls', label: '已记录模型调用' },
  { key: 'mix', label: 'LLM 调用构成' },
  { key: 'answer', label: '本轮回答' },
] as const

function sideLabel(side: Side): string {
  return side === 'left' ? '左侧' : '右侧'
}

function settled(
  summary: SummaryLane | undefined,
  lane: ComparisonMetricsResult['lanes'][number] | undefined,
): boolean {
  return (
    summary?.complete === true &&
    summary.run === 'settled' &&
    lane?.accounting.state !== 'unknown' &&
    lane?.accounting.issues.length === 0
  )
}

function incomplete(summary: SummaryLane | undefined, accountingState: string | undefined): boolean {
  return summary?.complete !== true || summary.run !== 'settled' || accountingState === 'unknown'
}

const displayNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)))

function formatTotal(total: ComparisonAccountingTotal | undefined, live: boolean, money = false): string {
  const number = (value: number) =>
    money ? (value > 0 && value < 0.000001 ? '<0.000001' : value.toFixed(6)) : displayNumber(value)
  if (total === undefined) return '未知'
  if (total.state === 'complete' && total.value !== null)
    return live ? `${number(total.value)}（已知下限）` : number(total.value)
  if (total.state === 'partial' && total.knownSubtotal !== null)
    return `已知小计 ${number(total.knownSubtotal)}（非总量，缺失 ${total.missing}）`
  return '未知'
}

function tokenText(total: ComparisonAccountingTotal | undefined, live: boolean): string {
  return live && total?.value === 0 ? '未知（尚无确认终态）' : formatTotal(total, live)
}

function familyText(
  family: ComparisonAccountingFamily | undefined,
  done: boolean,
  read: (family: ComparisonAccountingFamily) => string,
): string {
  if (!family) return '未知'
  if (family.attempts === 0) return done ? '不适用' : '未知'
  return read(family)
}

function priceBasis(family: ComparisonAccountingFamily): string {
  return family.currentPriceAttempts ? `（含 ${family.currentPriceAttempts} 次按当前配置重估）` : ''
}

/** Format already priced backend buckets; the client never recomputes rates. */
function bucketCost(
  family: ComparisonAccountingFamily,
  bucket: 'inputUncached' | 'cacheRead' | 'inputTotal' | 'output',
  live: boolean,
): string {
  const values = Object.entries(family.bucketCosts ?? {})
    .filter(
      ([, costs]) =>
        costs[bucket] !== undefined && !(costs[bucket]?.state === 'complete' && costs[bucket]?.value === 0),
    )
    .map(([currency, costs]) => `${currency} ${formatTotal(costs[bucket], live, true)}`)
  return values.length ? ` · ${values.join(' / ')}` : ''
}

function multiplierNote(family: ComparisonAccountingFamily): string {
  const values = family.priceMultipliers
  if (family.unpricedAttempts || !values?.length) return ''
  if (values.length > 1) return ' · 峰谷混合'
  return values[0] === 1 ? '' : ` · 谷段 ×${values[0]}`
}

function familyCost(family: ComparisonAccountingFamily, live: boolean): string {
  const values = Object.entries(family.costs)
  if (!values.length) return '未知（无价格证据）'
  return `${values.map(([currency, total]) => `${currency} ${formatTotal(total, live, true)}`).join(' / ')}${multiplierNote(family)}${priceBasis(family)}`
}

function cacheHit(family: ComparisonAccountingFamily, live: boolean): string {
  const read = family.tokens.cacheRead
  const input = family.tokens.inputTotal
  if (
    read?.state !== 'complete' ||
    read.value === null ||
    input?.state !== 'complete' ||
    input.value === null
  )
    return ' · 命中率未知'
  if (input.value === 0) return ' · 命中率不适用'
  const rate = `${((read.value / input.value) * 100).toFixed(1)}%`
  return ` · 命中率 ${live ? `${rate}（当前已知请求）` : rate}`
}

function combinedCost(lane: ComparisonMetricsResult['lanes'][number] | undefined, live: boolean): string {
  if (!lane?.accounting.totalCosts) return '未知（无合计费用证据）'
  const values = Object.entries(lane.accounting.totalCosts)
  if (!values.length) return '未知（无价格证据）'
  const current =
    (lane.accounting.llm.currentPriceAttempts ?? 0) + (lane.accounting.jev.currentPriceAttempts ?? 0)
  return `${values.map(([currency, total]) => `${currency} ${formatTotal(total, live, true)}`).join(' / ')}${current ? `（含 ${current} 次按当前配置重估）` : ''}`
}

function mix(
  lane: ComparisonMetricsResult['lanes'][number] | undefined,
  done: boolean,
  live: boolean,
): string {
  if (!lane) return '未知'
  const llm = lane.accounting.llm
  if (!llm.byPurpose) return '未知'
  const counts = new Map(Object.entries(llm.byPurpose).map(([purpose, value]) => [purpose, value.attempts]))
  if (counts.size === 0) {
    if (llm.attempts === 0) return done ? '不适用' : '未知'
    return '未知'
  }
  const keys = [
    ...purposeOrder.filter((purpose) => counts.has(purpose)),
    ...[...counts.keys()]
      .filter((purpose) => !purposeOrder.includes(purpose as (typeof purposeOrder)[number]))
      .sort(),
  ]
  const text = keys
    .map(
      (purpose) =>
        `${Object.hasOwn(purposeLabels, purpose) ? purposeLabels[purpose] : purpose} ${counts.get(purpose)}`,
    )
    .join(' · ')
  return live ? `${text}（部分可用）` : text
}

function statusText(summary: SummaryLane | undefined): string {
  if (!summary) return '未知'
  const phases: Record<string, string> = {
    idle: '空闲',
    running: '运行中',
    waiting: '等待中',
    parked: '已暂停',
    recovering: '恢复中',
    failed: '失败',
    completed: '已完成',
  }
  const runs: Record<string, string> = {
    reserved: '待执行',
    running: '执行中',
    waiting: '等待结算',
    settled: '已结算',
    unknown: '执行状态未知',
    none: '尚未执行',
  }
  const acceptances: Record<string, string> = {
    accepted: '已接收',
    rejected: '已拒绝',
    unknown: '接收未确认',
    none: '尚无输入',
  }
  return [
    phases[summary.phase] ?? '状态未知',
    runs[summary.run] ?? '执行状态未知',
    ...(summary.run === 'settled' ? [terminalLabels[summary.terminalCause]] : []),
    acceptances[summary.acceptance] ?? '接收未确认',
  ].join(' · ')
}

function elapsedText(summary: SummaryLane | undefined): string {
  if (!summary || summary.elapsedMs === null) return '未知'
  const seconds = `${(summary.elapsedMs / 1000).toFixed(1)} 秒`
  return summary.complete && summary.run === 'settled' ? seconds : `${seconds}（已确认累计）`
}

function cell(
  value: ComparisonMetricsResult | undefined,
  side: Side,
  key: (typeof rows)[number]['key'],
): { text: string; answer?: SummaryLane['latestAnswer'] } {
  if (!value) return { text: '未知' }
  const lane = value.lanes.find((item) => item.side === side)
  const summary = value.summary?.lanes.find((item) => item.side === side)
  const done = settled(summary, lane)
  const live = incomplete(summary, lane?.accounting.state)
  switch (key) {
    case 'status':
      return { text: statusText(summary) }
    case 'elapsed':
      return { text: elapsedText(summary) }
    case 'llm-uncached':
      return {
        text: familyText(
          lane?.accounting.llm,
          done,
          (family) =>
            `${tokenText(family.tokens.inputUncached, live)}${bucketCost(family, 'inputUncached', live)}`,
        ),
      }
    case 'llm-cache':
      return {
        text: familyText(
          lane?.accounting.llm,
          done,
          (family) =>
            `${tokenText(family.tokens.cacheRead, live)}${cacheHit(family, live)}${bucketCost(family, 'cacheRead', live)}`,
        ),
      }
    case 'llm-output':
      return {
        text: familyText(
          lane?.accounting.llm,
          done,
          (family) => `${tokenText(family.tokens.output, live)}${bucketCost(family, 'output', live)}`,
        ),
      }
    case 'jev-input':
      return {
        text: familyText(
          lane?.accounting.jev,
          done,
          (family) => `${tokenText(family.tokens.inputTotal, live)}${bucketCost(family, 'inputTotal', live)}`,
        ),
      }
    case 'jev-output':
      return {
        text: familyText(
          lane?.accounting.jev,
          done,
          (family) => `${tokenText(family.tokens.output, live)}${bucketCost(family, 'output', live)}`,
        ),
      }
    case 'llm-cost':
      return { text: familyText(lane?.accounting.llm, done, (family) => familyCost(family, live)) }
    case 'jev-cost':
      return { text: familyText(lane?.accounting.jev, done, (family) => familyCost(family, live)) }
    case 'cost':
      return { text: combinedCost(lane, live) }
    case 'calls': {
      if (!lane) return { text: '未知' }
      const llm = lane.accounting.llm.attempts
      const jev = lane.accounting.jev.attempts
      if (llm === 0 && jev === 0 && !done) return { text: '未知' }
      return { text: `LLM ${llm} 次 / Jev ${jev} 次${live ? '（部分可用）' : ''}` }
    }
    case 'mix':
      return { text: mix(lane, done, live) }
    case 'answer': {
      if (!summary) return { text: '未知' }
      if (!summary.latestAnswer)
        return { text: summary.complete && summary.run === 'settled' ? '无本轮回答' : '未知' }
      return { text: summary.latestAnswer.text, answer: summary.latestAnswer }
    }
  }
}

function heading(value: ComparisonMetricsResult | undefined, side: Side): string {
  const lane = value?.lanes.find((item) => item.side === side)
  const summary = value?.summary?.lanes.find((item) => item.side === side)
  const runtime = lane
    ? `${lane.runtime.id === 'jevloop' ? 'JevLoop' : lane.runtime.id === 'native' ? 'Native LLM' : lane.runtime.id}@${lane.runtime.version}`
    : '此前缀无会话绑定'
  return `${runtime} · ${sideLabel(side)}${summary?.run === 'settled' ? ` · ${terminalLabels[summary.terminalCause]}` : ''}`
}

function orderedSides(value: ComparisonMetricsResult | undefined): Side[] {
  return [...SIDES].sort(
    (a, b) =>
      Number(value?.lanes.find((lane) => lane.side === b)?.runtime.id === 'jevloop') -
      Number(value?.lanes.find((lane) => lane.side === a)?.runtime.id === 'jevloop'),
  )
}

function paintTable(table: HTMLTableElement, value: ComparisonMetricsResult | undefined): void {
  table.replaceChildren()
  const caption = document.createElement('caption')
  caption.textContent = value
    ? `累计用量与费用 · 共享 journal #${value.atSeq}${
        value.summary
          ? ` · ${value.summary.roundCount} 轮${value.summary.inputId ? ` · 输入 ${value.summary.inputId.slice(0, 8)}` : ''}`
          : ' · 摘要未知（旧服务未提供）'
      }`
    : '累计用量与费用 · 正在载入共享 journal'
  const sides = orderedSides(value)
  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  const corner = document.createElement('th')
  corner.scope = 'col'
  headRow.append(corner)
  for (const side of sides) {
    const column = document.createElement('th')
    column.scope = 'col'
    column.dataset.side = side
    column.textContent = heading(value, side)
    headRow.append(column)
  }
  head.append(headRow)
  const body = document.createElement('tbody')
  for (const row of rows) {
    const tr = document.createElement('tr')
    tr.dataset.resultMetric = row.key
    const label = document.createElement('th')
    label.scope = 'row'
    label.textContent = row.label
    tr.append(label)
    for (const side of sides) {
      const td = document.createElement('td')
      td.dataset.side = side
      const rendered = cell(value, side, row.key)
      if (row.key === 'answer' && rendered.answer) {
        const preview = document.createElement('pre')
        preview.className = 'comparison-results-answer'
        preview.textContent = rendered.answer.text
        const actions = document.createElement('div')
        actions.className = 'comparison-results-answer-actions'
        const copy = document.createElement('button')
        copy.type = 'button'
        copy.dataset.copyAnswer = side
        copy.textContent = '复制'
        copy.setAttribute('aria-label', `${sideLabel(side)}本轮回答复制`)
        actions.append(copy)
        if (rendered.answer.truncated) {
          const mark = document.createElement('span')
          mark.textContent = '已截断'
          actions.append(mark)
        }
        td.append(preview, actions)
        td.dataset.answerSeq = String(rendered.answer.seq)
      } else td.textContent = rendered.text
      tr.append(td)
    }
    body.append(tr)
  }
  table.append(caption, head, body)
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  document.execCommand('copy')
  field.remove()
}

/** Always-visible compact two-column shortcut over one metrics.render payload. */
export function createComparisonResults(host: HTMLElement) {
  const root = document.createElement('section')
  root.className = 'comparison-results'
  root.dataset.state = 'loading'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  status.className = 'comparison-results-status'
  status.textContent = '正在载入共享 journal'
  const note = document.createElement('p')
  note.className = 'comparison-results-note'
  note.textContent =
    '调用与用量来自持久记录；当前价格重估单独标明。耗时为已确认累计墙钟。缺失不表示零；进行中的已知值为下限。网关账单在下方明细中单独列出。'
  const table = document.createElement('table')
  table.className = 'comparison-results-table'
  paintTable(table, undefined)
  const prepared = document.createElement('div')
  prepared.className = 'comparison-results-prepared'
  root.append(status, note, table, prepared)
  host.append(root)
  root.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.('button[data-copy-answer]')
    if (!(button instanceof HTMLButtonElement)) return
    const side = button.dataset.copyAnswer
    const preview = button.closest('td')?.querySelector('.comparison-results-answer')?.textContent
    if ((side !== 'left' && side !== 'right') || !preview) return
    void copyText(preview).then(
      () => {
        button.textContent = '已复制'
      },
      () => {
        button.textContent = '复制失败'
      },
    )
  })
  let applied: number | undefined
  const retain = (text: string, state: 'updating' | 'unavailable') => {
    root.dataset.state = state
    status.textContent = text
  }
  return {
    loading(seq: number) {
      retain(`正在同步计量 #${seq}${applied === undefined ? '' : `；仍显示 #${applied} 的结果`}`, 'updating')
      root.dataset.pendingSeq = String(seq)
    },
    unavailable(reason: string) {
      retain(reason, 'unavailable')
    },
    render(value: ComparisonMetricsResult, rebuild: boolean) {
      applied = value.atSeq
      root.dataset.state = 'ready'
      root.dataset.atSeq = String(value.atSeq)
      delete root.dataset.pendingSeq
      if (value.summary?.inputId) root.dataset.inputId = value.summary.inputId
      else delete root.dataset.inputId
      status.textContent = value.summary
        ? `快捷结果截至共享 journal #${value.atSeq}`
        : `快捷结果截至共享 journal #${value.atSeq}；摘要未知（旧服务未提供）`
      if (rebuild) {
        paintTable(table, value)
        prepared.replaceChildren()
        for (const side of orderedSides(value)) {
          const lane = value.lanes.find((item) => item.side === side)
          const section = document.createElement('section')
          section.dataset.side = side
          const heading = document.createElement('h4')
          heading.textContent =
            lane?.runtime.id === 'jevloop'
              ? 'JevLoop'
              : lane?.runtime.id === 'native'
                ? 'Native LLM'
                : sideLabel(side)
          section.append(heading)
          renderComparisonPrepared(section, lane?.prepared)
          prepared.append(section)
        }
      }
    },
    reset() {
      applied = undefined
      prepared.replaceChildren()
      root.dataset.state = 'loading'
      delete root.dataset.atSeq
      delete root.dataset.inputId
      delete root.dataset.pendingSeq
      status.textContent = '正在载入共享 journal'
      paintTable(table, undefined)
    },
  }
}
