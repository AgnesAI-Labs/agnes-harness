import type {
  ComparisonAccountingFamily,
  ComparisonAccountingTotal,
  ComparisonMetricsResult,
} from '@agnes/protocol'
import { createComparisonPriceDetails, type PriceDetailsLoader } from './comparison-price-details.js'
import { createComparisonResults } from './comparison-results.js'

const tokenLabels: Record<keyof ComparisonAccountingFamily['tokens'], string> = {
  inputUncached: '未缓存输入',
  cacheRead: '缓存读取',
  cacheWrite: '缓存写入',
  output: '输出',
  reasoning: '推理（包含于输出）',
  inputTotal: '总输入（含缓存）',
  total: '总 token',
}
function amount(total: ComparisonAccountingTotal | undefined): string {
  if (total === undefined) return '未知'
  if (total.state === 'complete' && total.value !== null) return String(total.value)
  if (total.state === 'partial' && total.knownSubtotal !== null)
    return `已知小计 ${total.knownSubtotal}（非总量，缺失 ${total.missing}）`
  return '未知'
}

/** Equivalent fixed-cut replies must not retire expanded detail readers during polling. */
function metricsSignature(value: ComparisonMetricsResult): string {
  return JSON.stringify(
    { ...value, lanes: [...value.lanes].sort((left, right) => left.side.localeCompare(right.side)) },
    (key, item: unknown) => {
      if (key === 'issues' && Array.isArray(item)) return [...item].sort()
      if (item !== null && typeof item === 'object' && !Array.isArray(item))
        return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      return item
    },
  )
}

/** Render the wire accounting verbatim; rates, baseline windows and missing values stay backend-owned. */
export function createComparisonMetrics(host: HTMLElement, loadPriceDetails?: PriceDetailsLoader) {
  const results = createComparisonResults(host)
  const panel = document.createElement('details')
  panel.className = 'comparison-metrics'
  panel.open = false
  const title = document.createElement('summary')
  title.textContent = '前缀计量 · 正在载入共享 journal'
  const note = document.createElement('p')
  note.setAttribute('role', 'status')
  const body = document.createElement('div')
  body.className = 'comparison-metrics-lanes'
  panel.append(title, note, body)
  host.append(panel)
  let detailReaders: ReturnType<typeof createComparisonPriceDetails>[] = []
  const clearReaders = () => {
    for (const reader of detailReaders) reader.dispose()
    detailReaders = []
  }
  let applied: number | undefined
  let appliedTitle: string | undefined
  let appliedSignature: string | undefined
  return {
    loading(seq: number) {
      results.loading(seq)
      title.textContent = `${appliedTitle ?? '前缀计量'} · 正在同步 #${seq}`
      note.textContent = `正在同步计量 #${seq}${applied === undefined ? '' : `；仍显示 #${applied} 的结果`}`
    },
    unavailable(reason: string) {
      results.unavailable(reason)
      title.textContent = `${appliedTitle ?? '前缀计量'} · 读取不可用（展开查看）`
      note.textContent = reason
    },
    render(value: ComparisonMetricsResult) {
      applied = value.atSeq
      const state = (value: string) =>
        value === 'complete' ? '完整' : value === 'partial' ? '部分可用' : '未知'
      const brief = value.lanes
        .map(
          (lane) =>
            `${lane.side === 'left' ? '左' : '右'}：Jev ${lane.accounting.jev.attempts} / LLM ${lane.accounting.llm.attempts} 已观测请求（${state(lane.accounting.state)}）`,
        )
        .join(' · ')
      title.textContent = `前缀计量 · 共享 journal #${value.atSeq}${brief ? ` · ${brief}` : ''}`
      appliedTitle = title.textContent
      note.textContent =
        '用量来自持久记录；价格估算、网关报告金额与已报告估算金额分开显示。缺失不表示零，订阅标记不表示免费。'
      panel.dataset.atSeq = String(value.atSeq)
      const signature = metricsSignature(value)
      const rebuild = signature !== appliedSignature
      if (rebuild) {
        appliedSignature = signature
        clearReaders()
        body.replaceChildren()
      }
      results.render(value, rebuild)
      if (!rebuild) return
      for (const side of ['left', 'right'] as const) {
        const section = document.createElement('section')
        section.dataset.side = side
        const heading = document.createElement('h4')
        const lane = value.lanes.find((item) => item.side === side)
        heading.textContent = `${side === 'left' ? '左侧' : '右侧'}${lane ? ` · ${lane.runtime.id}@${lane.runtime.version}` : ' · 此前缀无会话绑定'}`
        section.append(heading)
        if (lane) {
          const window = document.createElement('p')
          window.textContent = `父账本 (${lane.accounting.afterSeq}, ${lane.accounting.throughSeq}] · 会话树 ${lane.members?.length ?? 1} 个已观测成员 · ${lane.treeComplete === true ? '树覆盖完整' : '树覆盖不完整或未知'} · ${lane.accounting.state === 'complete' ? '完整' : lane.accounting.state === 'partial' ? '部分可用' : '未知'}`
          section.append(window)
          for (const family of ['jev', 'llm'] as const) {
            const accounting = lane.accounting[family]
            const label = document.createElement('h5')
            label.textContent = `${family === 'jev' ? 'Jev 决策' : 'LLM 语言'} · 已观测请求 ${accounting.attempts}`
            const list = document.createElement('dl')
            list.dataset.family = family
            const row = (name: string, text: string) => {
              const key = document.createElement('dt')
              key.textContent = name
              const value = document.createElement('dd')
              value.textContent = text
              list.append(key, value)
            }
            for (const [bucket, label] of Object.entries(tokenLabels))
              row(label, amount(accounting.tokens[bucket as keyof typeof tokenLabels]))
            for (const [currency, total] of Object.entries(accounting.costs))
              row(`价格估算费用 ${currency}`, amount(total))
            if (Object.keys(accounting.costs).length === 0)
              row('价格估算费用', accounting.attempts === 0 ? '暂无已观测请求' : '未知（无价格证据）')
            row(
              '按当前配置重估请求',
              accounting.currentPriceAttempts === undefined
                ? '未知'
                : String(accounting.currentPriceAttempts),
            )
            row('缺价请求', String(accounting.unpricedAttempts))
            const outcomes = (counts: NonNullable<typeof accounting.outcomes>) =>
              `完成 ${counts.completed} · 失败 ${counts.failed} · 取消 ${counts.cancelled} · 待定 ${counts.pending} · 未知 ${counts.unknown}`
            row(
              '已观测请求结果',
              accounting.outcomes ? outcomes(accounting.outcomes) : '未知（旧记录未提供）',
            )
            const purposes: Record<string, string> = {
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
            if (accounting.byPurpose)
              for (const [purpose, value] of Object.entries(accounting.byPurpose))
                row(
                  `用途：${Object.hasOwn(purposes, purpose) ? purposes[purpose] : purpose}`,
                  `${value.attempts} 已观测请求 · ${outcomes(value.outcomes)}`,
                )
            const billing = accounting.reportedBilling
            if (billing) {
              for (const source of ['gateway', 'estimated'] as const) {
                const report = billing[source]
                const label = source === 'gateway' ? '网关报告' : '已报告估算'
                row(
                  `${label}金额（微美元）`,
                  report.attempts === 0 && report.usdMicros.state === 'complete'
                    ? '暂无该来源金额报告'
                    : amount(report.usdMicros),
                )
                row(
                  `${label}覆盖`,
                  `${report.attempts} 已观测请求 · 订阅 ${report.subscriptionAttempts} · 非订阅 ${report.nonSubscriptionAttempts}`,
                )
              }
              row('缺少金额报告的请求', String(billing.missingAttempts))
            } else row('已报告金额', '未知（旧记录未提供）')
            section.append(label, list)
          }
          if (lane.accounting.issues.length > 0) {
            const issues = document.createElement('details')
            const summary = document.createElement('summary')
            summary.textContent = '证据不完整，查看读取限制'
            const raw = document.createElement('pre')
            raw.textContent = lane.accounting.issues.join('\n')
            issues.append(summary, raw)
            section.append(issues)
          }
        }
        if (lane && loadPriceDetails) {
          if (lane.members?.length)
            for (const member of lane.members)
              detailReaders.push(
                createComparisonPriceDetails(
                  section,
                  value,
                  {
                    ...lane,
                    sessionId: member.sessionId,
                    runtime: member.runtime,
                    accounting: member.accounting,
                  },
                  loadPriceDetails,
                  member.sessionId === lane.sessionId ? undefined : member.sessionId,
                ),
              )
          else detailReaders.push(createComparisonPriceDetails(section, value, lane, loadPriceDetails))
        }
        body.append(section)
      }
    },
    reset() {
      results.reset()
      clearReaders()
      applied = undefined
      appliedTitle = undefined
      appliedSignature = undefined
      delete panel.dataset.atSeq
      title.textContent = '前缀计量 · 正在载入共享 journal'
      note.textContent = ''
      body.replaceChildren()
    },
  }
}
