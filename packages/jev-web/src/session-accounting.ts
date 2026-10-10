import type {
  ComparisonAccountingFamily,
  ComparisonAccountingTotal,
  SessionAccountingResult,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import type { Translate } from './jev-locale.js'
import { positionPopover } from '@agnes/web-ui'

function total(
  t: Translate,
  value: ComparisonAccountingTotal | undefined,
  money = false,
): string {
  if (!value || value.state === 'unknown') return t('acct.unknown')
  const format = (n: number) => (money ? n.toFixed(6) : n.toLocaleString('en-US'))
  if (value.state === 'complete' && value.value !== null) return format(value.value)
  return value.knownSubtotal === null
    ? t('acct.unknown')
    : t('acct.total.partial', { subtotal: format(value.knownSubtotal), missing: value.missing })
}

function costs(t: Translate, family: ComparisonAccountingFamily): string {
  const entries = Object.entries(family.costs)
  if (!entries.length) return family.attempts === 0 ? t('acct.costs.none') : t('acct.costs.noPrices')
  const basis = family.currentPriceAttempts ? t('acct.costs.basis', { count: family.currentPriceAttempts }) : ''
  return `${entries.map(([currency, amount]) => `${currency} ${total(t, amount, true)}`).join(' / ')}${basis}`
}

function cacheRate(t: Translate, family: ComparisonAccountingFamily): string {
  const read = family.tokens.cacheRead
  const input = family.tokens.inputTotal
  if (
    read?.state !== 'complete' ||
    input?.state !== 'complete' ||
    read.value === null ||
    input.value === null
  )
    return t('acct.unknown')
  if (input.value === 0) return t('acct.cache.na')
  return `${((read.value / input.value) * 100).toFixed(1)}%`
}

/** Plugin-owned reader of the same durable accounting projection used by comparison. */
export function createSessionAccounting(host: HTMLElement, client: Pick<Client, 'call'>, t: Translate) {
  const panel = document.createElement('details')
  panel.className = 'jev-session-accounting'
  panel.hidden = true
  const summary = document.createElement('summary')
  summary.textContent = t('acct.summary.loading')
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
  let failed = false
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
    const state = accounting.state === 'complete' ? t('acct.state.complete') : t('acct.state.partial')
    summary.textContent = t('acct.summary.counts', { llm: llm.attempts, jev: jev.attempts, state })
    const note = document.createElement('p')
    note.textContent = t('acct.note', { seq: accounting.throughSeq })
    const list = document.createElement('dl')
    row(list, t('acct.row.llmAttempts'), String(llm.attempts))
    row(list, t('acct.row.llmInput'), total(t, llm.tokens.inputTotal))
    row(list, t('acct.row.llmCacheRead'), total(t, llm.tokens.cacheRead))
    row(list, t('acct.row.llmCacheRate'), cacheRate(t, llm))
    row(list, t('acct.row.llmOutput'), total(t, llm.tokens.output))
    row(list, t('acct.row.llmCost'), costs(t, llm))
    row(list, t('acct.row.jevAttempts'), String(jev.attempts))
    row(list, t('acct.row.jevInput'), total(t, jev.tokens.inputTotal))
    row(list, t('acct.row.jevOutput'), total(t, jev.tokens.output))
    row(list, t('acct.row.jevCost'), costs(t, jev))
    const combined = Object.entries(accounting.totalCosts ?? {})
    row(
      list,
      t('acct.row.totalCost'),
      combined.length
        ? combined.map(([currency, amount]) => `${currency} ${total(t, amount, true)}`).join(' / ')
        : t('acct.total.noEvidence'),
    )
    if (accounting.issues.length) row(list, t('acct.row.issues'), accounting.issues.join(' · '))
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
      failed = false
      render(result)
    } catch (error) {
      if (!disposed && generation === ticket) {
        seenHead = targetHead
        failed = true
        summary.textContent = t('acct.summary.failed')
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
    if (sessionId && failed) {
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
        failed = false
        summary.textContent = t('acct.summary.loading')
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
