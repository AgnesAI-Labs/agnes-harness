import type {
  ComparisonAccountingFamily,
  ComparisonAccountingTotal,
  SessionAccountingResult,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { positionPopover } from '@agnes/web-ui'

function total(value: ComparisonAccountingTotal | undefined, money = false): string {
  if (!value || value.state === 'unknown') return '未知'
  const format = (n: number) => (money ? n.toFixed(6) : n.toLocaleString('en-US'))
  if (value.state === 'complete' && value.value !== null) return format(value.value)
  return value.knownSubtotal === null
    ? '未知'
    : `已知小计 ${format(value.knownSubtotal)}（非总量，缺失 ${value.missing}）`
}

function costs(family: ComparisonAccountingFamily): string {
  const entries = Object.entries(family.costs)
  if (!entries.length) return family.attempts === 0 ? '暂无已观测请求' : '未知（无价格证据）'
  const basis = family.currentPriceAttempts ? ` · ${family.currentPriceAttempts} 次按当前配置重估` : ''
  return `${entries.map(([currency, amount]) => `${currency} ${total(amount, true)}`).join(' / ')}${basis}`
}

function cacheRate(family: ComparisonAccountingFamily): string {
  const read = family.tokens.cacheRead
  const input = family.tokens.inputTotal
  if (
    read?.state !== 'complete' ||
    input?.state !== 'complete' ||
    read.value === null ||
    input.value === null
  )
    return '未知'
  if (input.value === 0) return '不适用'
  return `${((read.value / input.value) * 100).toFixed(1)}%`
}

/** Plugin-owned reader of the same durable accounting projection used by comparison. */
export function createSessionAccounting(host: HTMLElement, client: Pick<Client, 'call'>) {
  const panel = document.createElement('details')
  panel.className = 'jev-session-accounting'
  panel.hidden = true
  const summary = document.createElement('summary')
  summary.textContent = '单线计量 · 正在读取'
  const body = document.createElement('div')
  body.className = 'jev-session-accounting-body'
  body.setAttribute('popover', 'manual')
  panel.append(summary, body)
  host.append(panel)
  let sessionId: string | undefined
  let targetHead = 0
  let seenHead = -1
  let ticket = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let loading = false
  let disposed = false
  const listeners = new AbortController()
  const place = () => {
    if (panel.open) positionPopover(summary, body, { preferredWidth: 370, preferredHeight: 480 })
  }
  const sync = () => {
    if (typeof body.showPopover !== 'function') return
    if (panel.open) {
      if (!body.matches(':popover-open')) body.showPopover()
      place()
    } else if (body.matches(':popover-open')) body.hidePopover()
  }
  panel.addEventListener('toggle', sync, { signal: listeners.signal })
  document.addEventListener(
    'click',
    (event) => {
      if (panel.open && !event.composedPath().includes(panel)) panel.open = false
    },
    { signal: listeners.signal },
  )
  document.addEventListener(
    'keydown',
    (event) => {
      if (panel.open && event.key === 'Escape') panel.open = false
    },
    { signal: listeners.signal },
  )
  window.addEventListener('resize', place, { signal: listeners.signal })
  document.addEventListener('scroll', place, { capture: true, signal: listeners.signal })

  const schedule = (delay: number) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void read()
    }, delay)
  }
  const row = (list: HTMLDListElement, label: string, value: string) => {
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')
    dt.textContent = label
    dd.textContent = value
    list.append(dt, dd)
  }
  const render = (result: SessionAccountingResult) => {
    const { accounting } = result
    const { llm, jev } = accounting
    const state = accounting.state === 'complete' ? '证据完整' : '证据部分可用'
    summary.textContent = `单线计量 · LLM ${llm.attempts} 次 / Jev ${jev.attempts} 次 · ${state}`
    const note = document.createElement('p')
    note.textContent = `根会话账本 #${accounting.throughSeq} · 仅统计已观测请求；缺失用量不按零计算。子会话未纳入。`
    const list = document.createElement('dl')
    row(list, 'LLM 调用次数', String(llm.attempts))
    row(list, 'LLM 输入 Token', total(llm.tokens.inputTotal))
    row(list, 'LLM 缓存读取 Token', total(llm.tokens.cacheRead))
    row(list, 'LLM 缓存命中率', cacheRate(llm))
    row(list, 'LLM 输出 Token', total(llm.tokens.output))
    row(list, 'LLM 估算总成本', costs(llm))
    row(list, 'Jev 调用次数', String(jev.attempts))
    row(list, 'Jev 输入 Token', total(jev.tokens.inputTotal))
    row(list, 'Jev 输出 Token', total(jev.tokens.output))
    row(list, 'Jev 估算总成本', costs(jev))
    const combined = Object.entries(accounting.totalCosts ?? {})
    row(
      list,
      '合计估算成本',
      combined.length
        ? combined.map(([currency, amount]) => `${currency} ${total(amount, true)}`).join(' / ')
        : '未知（无合计费用证据）',
    )
    if (accounting.issues.length) row(list, '证据问题', accounting.issues.join(' · '))
    body.replaceChildren(note, list)
    panel.dataset.throughSeq = String(accounting.throughSeq)
  }
  async function read() {
    if (disposed || !sessionId || loading || seenHead >= targetHead) return
    const id = sessionId
    const generation = ticket
    loading = true
    try {
      const result = await client.call<SessionAccountingResult>('_agnes/v1/session.accounting', {
        sessionId: id,
      })
      if (disposed || generation !== ticket || result.sessionId !== id || result.runtime.id !== 'jevloop')
        return
      if (result.accounting.throughSeq < seenHead) throw new Error('计量账本水位回退')
      seenHead = result.accounting.throughSeq
      render(result)
    } catch (error) {
      if (!disposed && generation === ticket) {
        seenHead = targetHead
        summary.textContent = '单线计量 · 读取失败（点击重试）'
        body.textContent = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (generation === ticket) {
        loading = false
        if (!disposed && seenHead < targetHead) schedule(800)
      }
    }
  }
  const retry = () => {
    if (sessionId && summary.textContent?.includes('读取失败')) {
      seenHead = -1
      schedule(0)
    }
  }
  panel.addEventListener('toggle', () => {
    if (panel.open && seenHead < targetHead) schedule(0)
  })
  summary.addEventListener('click', retry)
  return {
    update(id: string | undefined, head = 0) {
      if (disposed) return
      panel.hidden = id === undefined
      if (id !== sessionId) {
        panel.open = false
        sessionId = id
        targetHead = head
        seenHead = -1
        ticket++
        loading = false
        body.replaceChildren()
        summary.textContent = '单线计量 · 正在读取'
        if (id) schedule(0)
      } else if (head > targetHead) {
        targetHead = head
        schedule(350)
      }
    },
    dispose() {
      disposed = true
      panel.open = false
      if (body.matches(':popover-open')) body.hidePopover()
      listeners.abort()
      ticket++
      if (timer !== undefined) clearTimeout(timer)
      panel.remove()
    },
  }
}
