import type {
  ComparisonMetricsResult,
  ComparisonPriceDetailsParams,
  ComparisonPriceDetailsResult,
} from '@agnes/protocol'

export type PriceDetailsLoader = (
  input: ComparisonPriceDetailsParams,
) => Promise<ComparisonPriceDetailsResult>
const purposes: Record<string, string> = {
  inference: '原生推理',
  decision: '决策',
  parameters: '参数生成',
  arbitration: '仲裁',
  answer: '回答',
  compaction: '压缩摘要',
  title: '会话标题',
  media: '媒体',
}
const labels = { inputUncached: '未缓存输入', cacheRead: '缓存读取', cacheWrite: '缓存写入', output: '输出' }
const total = (value: ComparisonPriceDetailsResult['entries'][number]['estimate'] | undefined) =>
  value === undefined
    ? '未知'
    : value.state === 'complete' && value.value !== null
      ? String(value.value)
      : value.knownSubtotal !== null
        ? `已知小计 ${value.knownSubtotal}（非总量）`
        : '未知'

/** Lazy pages belong to this exact committed cursor; disposed or older replies never render. */
export function createComparisonPriceDetails(
  host: HTMLElement,
  value: ComparisonMetricsResult,
  lane: ComparisonMetricsResult['lanes'][number],
  load?: PriceDetailsLoader,
  memberSessionId?: string,
) {
  const panel = document.createElement('details')
  panel.className = 'comparison-price-details'
  const summary = document.createElement('summary')
  summary.textContent = memberSessionId
    ? `子会话 ${memberSessionId} · 报价依据与逐请求费用`
    : '父会话 · 报价依据与逐请求费用'
  const status = document.createElement('p')
  status.setAttribute('role', 'status')
  status.textContent = load ? '展开读取当前前缀的报价与估算来源。' : '报价详情读取不可用。'
  const body = document.createElement('div')
  const more = document.createElement('button')
  more.type = 'button'
  more.textContent = '读取更多请求'
  more.hidden = true
  panel.append(summary, status, body, more)
  host.append(panel)
  let disposed = false
  let pending = false
  let loaded = false
  let afterSeq = 0
  let complete = false
  let evidenceComplete = true
  const seen = new Set<string>()
  async function read() {
    if (disposed || pending || complete || !load) return
    pending = true
    more.disabled = true
    status.textContent = `正在读取共享 journal #${value.atSeq} · 本侧 #${lane.accounting.throughSeq}`
    try {
      const page = await load({
        id: value.id,
        side: lane.side,
        atSeq: value.atSeq,
        ...(memberSessionId ? { memberSessionId } : {}),
        afterSeq,
        limit: 25,
        maxBytes: 262144,
      })
      if (disposed) return
      if (
        page.entries.length > 25 ||
        new TextEncoder().encode(JSON.stringify(page.entries)).byteLength > 262144 ||
        page.id !== value.id ||
        page.side !== lane.side ||
        page.atSeq !== value.atSeq ||
        page.sessionId !== lane.sessionId ||
        page.runtime.id !== lane.runtime.id ||
        page.runtime.version !== lane.runtime.version ||
        page.throughSeq !== lane.accounting.throughSeq ||
        page.afterSeq !== afterSeq ||
        page.nextAfterSeq > page.throughSeq ||
        (!page.complete && page.nextAfterSeq <= afterSeq) ||
        (page.complete && page.nextAfterSeq !== page.throughSeq)
      )
        throw new Error('报价详情返回了不同的前缀或缺失分页进度')
      let previous = afterSeq
      for (const entry of page.entries) {
        if (
          entry.originSeq <= previous ||
          entry.originSeq > page.throughSeq ||
          (entry.settledSeq !== null &&
            (entry.settledSeq < entry.originSeq || entry.settledSeq > page.throughSeq)) ||
          seen.has(entry.attemptId)
        )
          throw new Error('报价详情的请求坐标冲突')
        previous = entry.originSeq
      }
      if (!page.complete && page.nextAfterSeq !== previous) throw new Error('报价详情分页跳过了请求')
      for (const entry of page.entries) {
        seen.add(entry.attemptId)
        const row = document.createElement('section')
        const heading = document.createElement('h5')
        heading.textContent = `${entry.family === 'jev' ? 'Jev 决策' : 'LLM 语言'} · ${entry.purpose === null ? '未知用途' : (purposes[entry.purpose] ?? entry.purpose)} · 本侧 #${entry.originSeq}`
        const model = document.createElement('p')
        model.textContent = `请求 ${entry.route ?? '未知路由'} / ${entry.model ?? '未知模型'} · 实际 ${entry.observedModel ?? '未知模型'} · ${{ pending: '待定', completed: '完成', failed: '失败', cancelled: '取消', unknown: '未知' }[entry.outcome]}`
        row.append(heading, model)
        const quote = entry.quote
        const price = document.createElement('p')
        price.textContent = quote
          ? `${entry.priceBasis === 'current' ? '按当前配置重估（未写入历史记录）' : quote.basis === 'configured' ? '冻结的配置报价' : '冻结的目录估算'} · ${quote.policy.currency} / 百万 token · 倍率 ${entry.multiplier ?? '未知'} · 请求时间 ${new Date(quote.admittedAt).toISOString()}`
          : '未知（无有效历史报价）'
        row.append(price)
        if (quote) {
          const rates = document.createElement('p')
          rates.textContent = Object.entries(labels)
            .map(
              ([bucket, label]) =>
                `${label} ${quote.policy.perMillion[bucket as keyof typeof labels] ?? '未知'}`,
            )
            .join(' · ')
          row.append(rates)
          if (quote.policy.source) {
            const source = document.createElement('p')
            source.textContent = `来源核对 ${quote.policy.source.checkedAt} · `
            // Rendering cannot make an untrusted persisted URL executable.
            const link = document.createElement('a')
            link.textContent = quote.policy.source.url
            if (quote.policy.source.url.startsWith('https://')) {
              link.href = quote.policy.source.url
              link.target = '_blank'
              link.rel = 'noopener noreferrer'
            }
            source.append(link)
            row.append(source)
          }
          const policy = document.createElement('details')
          const caption = document.createElement('summary')
          caption.textContent =
            entry.priceBasis === 'current' ? '估算政策（当前配置）' : '有效期与峰谷政策（历史快照）'
          const raw = document.createElement('pre')
          raw.textContent = JSON.stringify(
            {
              validFrom: quote.policy.validFrom ?? null,
              validUntil: quote.policy.validUntil ?? null,
              offPeak: quote.policy.offPeak ?? null,
            },
            null,
            2,
          )
          policy.append(caption, raw)
          row.append(policy)
        }
        const amounts = document.createElement('p')
        const amountLabels = entry.bucketCosts.inputTotal ? { inputTotal: '总输入', output: '输出' } : labels
        amounts.textContent = `${Object.entries(amountLabels)
          .map(
            ([bucket, label]) =>
              `${label} ${total(entry.tokens[bucket as keyof typeof entry.bucketCosts])} token · 费用 ${total(entry.bucketCosts[bucket as keyof typeof entry.bucketCosts])}`,
          )
          .join(
            ' · ',
          )} · ${entry.priceBasis === 'current' ? '当前配置重估' : '历史报价估算'} ${total(entry.estimate)}${quote ? ` ${quote.policy.currency}` : ''}`
        row.append(amounts)
        const reasoning = document.createElement('p')
        reasoning.textContent = `推理 token（包含于输出，不另计费）${total(entry.tokens.reasoning)}`
        row.append(reasoning)
        const billing = document.createElement('p')
        billing.textContent = entry.reportedBilling
          ? `${entry.reportedBilling.source === 'gateway' ? '网关报告' : '已报告估算'} ${entry.reportedBilling.usdMicros} 微美元 · 订阅 ${entry.reportedBilling.subscription ? '是' : '否'}`
          : '报告金额未知'
        row.append(billing)
        if (entry.issues.length) {
          const issue = document.createElement('details')
          const caption = document.createElement('summary')
          const reasons: Record<string, string> = {
            pending: '请求尚未结算',
            missing_quote: '缺少历史报价',
            observed_model_mismatch: '实际模型与报价模型不同',
            quote_binding_mismatch: '报价归属不匹配',
            invalid_price_interval: '有效期或峰谷区间无法确认',
            missing_usage: '缺少用量分桶',
            missing_rate: '缺少单价',
            incomplete_evidence: '源证据不完整',
          }
          caption.textContent = `费用未知或部分可用：${entry.issues.map((code) => reasons[code] ?? '证据冲突或无效').join('、')}`
          const raw = document.createElement('pre')
          raw.textContent = entry.issues.join('\n')
          issue.append(caption, raw)
          row.append(issue)
        }
        body.append(row)
      }
      afterSeq = page.nextAfterSeq
      complete = page.complete
      loaded = true
      evidenceComplete &&= page.evidenceComplete
      more.hidden = complete
      status.textContent = `共享 journal #${value.atSeq} · 本侧 #${page.throughSeq} · ${complete ? '已读完可见请求' : '还有请求'}${evidenceComplete ? '' : '；源证据不完整，费用只代表已知小计'}${seen.size === 0 ? '；暂无可见请求' : ''}`
    } catch (error) {
      if (!disposed) {
        status.textContent = `报价详情读取失败：${error instanceof Error ? error.message : String(error)}`
        more.hidden = false
      }
    } finally {
      pending = false
      more.disabled = false
    }
  }
  panel.addEventListener('toggle', () => {
    if (panel.open && !loaded) void read()
  })
  more.addEventListener('click', () => void read())
  return {
    dispose() {
      disposed = true
    },
  }
}
