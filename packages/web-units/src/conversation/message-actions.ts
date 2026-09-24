import type { UITurn } from '@agnes/protocol'
import { type ConversationFeedback, createConversationFeedback } from './feedback.js'

export interface ConversationMessageActions {
  readonly element: HTMLElement
  readonly feedback: ConversationFeedback
  update(state: ConversationMessageActionState): void
  dispose(): void
}

export interface ConversationMessageActionState {
  readonly turn: UITurn
  readonly finalText: string
  readonly settled: boolean
}

export interface ConversationMessageActionOptions {
  onFork?(turn: UITurn): Promise<void>
  bindAutoDismiss?(element: HTMLDetailsElement): void
}

const durationLabel = (duration?: number): string | undefined => {
  if (duration === undefined) return undefined
  if (duration < 1000) return `${duration} 毫秒`
  if (duration < 60_000) return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} 秒`
  return `${Math.floor(duration / 60_000)} 分 ${Math.round((duration % 60_000) / 1000)} 秒`
}

const usdLabel = (usdMicros: number): string => `$${(usdMicros / 1e6).toFixed(6)}`
const creditsLabel = (credits: number): string => credits.toFixed(8).replace(/\.?0+$/, '')
const sourceLabel = (source: 'gateway' | 'estimated'): string =>
  source === 'estimated' ? '估算' : '网关记录'

const latestInferenceModel = (turn: UITurn): string | undefined => {
  if (turn.finalModel !== undefined) return turn.finalModel
  for (let index = turn.usage.calls.length - 1; index >= 0; index--) {
    const call = turn.usage.calls[index]
    if (call?.purpose === 'inference' && !call.adjustment) return call.model
  }
  return undefined
}

function actionIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const data of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', data)
    svg.append(path)
  }
  return svg
}

function legacyCopy(text: string): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  const selection = globalThis.getSelection?.()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  document.body.append(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    textarea.remove()
    selection?.removeAllRanges()
    for (const range of ranges) selection?.addRange(range)
    active?.focus({ preventScroll: true })
  }
  return copied
}

function positionUsagePopover(meta: HTMLElement, usage: HTMLDListElement): void {
  const anchor = meta.getBoundingClientRect()
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight
  const gutter = 12
  const gap = 8
  const width = Math.max(0, Math.min(400, viewportWidth - gutter * 2))
  const left = Math.min(
    Math.max(gutter, anchor.right - width),
    Math.max(gutter, viewportWidth - width - gutter),
  )
  const below = Math.max(0, viewportHeight - anchor.bottom - gutter - gap)
  const above = Math.max(0, anchor.top - gutter - gap)
  usage.style.width = `${width}px`
  usage.style.left = `${left}px`
  usage.style.right = 'auto'
  if (below >= 220 || below >= above) {
    usage.style.top = `${Math.max(gutter, anchor.bottom + gap)}px`
    usage.style.bottom = 'auto'
    usage.style.maxHeight = `${below}px`
  } else {
    usage.style.top = 'auto'
    usage.style.bottom = `${Math.max(gutter, viewportHeight - anchor.top + gap)}px`
    usage.style.maxHeight = `${above}px`
  }
}

/** Owns the final-answer actions; the turn projector supplies only the current turn state. */
export function createConversationMessageActions(
  options: ConversationMessageActionOptions = {},
): ConversationMessageActions {
  const element = document.createElement('footer')
  element.className = 'turn-footer'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'turn-action'
  copy.setAttribute('aria-label', '复制回答')
  copy.title = '复制回答'
  copy.append(
    actionIcon([
      'M9 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z',
      'M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2',
    ]),
  )
  const fork = document.createElement('button')
  fork.type = 'button'
  fork.className = 'turn-action'
  fork.setAttribute('aria-label', '分支到新聊天')
  fork.title = '分支到新聊天'
  fork.append(actionIcon(['M6 3v5a4 4 0 0 0 4 4h8', 'm14 8 4 4-4 4', 'M6 21v-5a4 4 0 0 1 4-4']))
  const usagePanel = document.createElement('details')
  usagePanel.className = 'turn-usage'
  const meta = document.createElement('summary')
  meta.className = 'turn-meta'
  const usage = document.createElement('dl')
  usage.className = 'turn-usage-grid'
  usagePanel.append(meta, usage)
  const feedback = createConversationFeedback()
  element.append(copy, fork, usagePanel, feedback.element)
  options.bindAutoDismiss?.(usagePanel)

  let state: ConversationMessageActionState | undefined
  let forkPending = false
  let renderedUsageValues: readonly (string | number | boolean | undefined)[] | undefined
  let timeFormatter: Intl.DateTimeFormat | undefined

  const render = (): void => {
    if (!state) return
    const { finalText, settled, turn } = state
    element.hidden = !settled
    copy.hidden = !settled
    copy.disabled = !finalText
    fork.hidden = !settled || !turn.forkable
    fork.disabled = forkPending || !turn.forkable || !options.onFork
    usagePanel.hidden = !settled
    // Streaming updates still refresh action state, but the hidden usage table only needs its
    // current values when the turn settles and the footer becomes visible.
    if (!settled) return
    const model = latestInferenceModel(turn)
    const { totals, cost, credits, billingComplete } = turn.usage
    // Snapshot only displayed values: callers may mutate a turn or its usage in place.
    const usageValues = [
      turn.inherited,
      turn.endedAt,
      model,
      turn.durationMs,
      totals.input,
      totals.output,
      totals.cacheRead,
      totals.cacheWrite,
      cost?.usdMicros,
      cost?.source,
      cost?.subscription,
      cost ? billingComplete : undefined,
      credits?.amount,
      credits?.source,
      credits?.complete,
    ] as const
    if (renderedUsageValues?.every((value, index) => value === usageValues[index])) {
      if (usagePanel.open) positionUsagePopover(meta, usage)
      return
    }
    const duration = durationLabel(turn.durationMs)
    if (turn.endedAt)
      timeFormatter ??= new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })
    const facts = [
      turn.inherited ? '继承历史' : undefined,
      turn.endedAt ? timeFormatter?.format(new Date(turn.endedAt)) : undefined,
      model,
    ].filter(Boolean)
    meta.textContent = facts.join(' · ')
    meta.setAttribute('aria-label', '查看本轮用量与调用明细')
    const rows: Array<[string, string]> = [
      ['输入 Token', turn.usage.totals.input.toLocaleString()],
      ['输出 Token', turn.usage.totals.output.toLocaleString()],
      [
        '缓存读取 / 写入',
        `${turn.usage.totals.cacheRead.toLocaleString()} / ${turn.usage.totals.cacheWrite.toLocaleString()}`,
      ],
      ...(turn.usage.cost
        ? [
            [
              '费用',
              `${usdLabel(turn.usage.cost.usdMicros)} · ${sourceLabel(turn.usage.cost.source)}${turn.usage.cost.subscription ? ' · 订阅' : ''}${turn.usage.billingComplete ? '' : ' · 已知部分'}`,
            ] as [string, string],
          ]
        : []),
      ...(turn.usage.credits
        ? [
            [
              '额度',
              `${creditsLabel(turn.usage.credits.amount)} credits · ${sourceLabel(turn.usage.credits.source)}${turn.usage.credits.complete ? '' : ' · 部分'}`,
            ] as [string, string],
          ]
        : []),
      ...(duration ? [['用时', duration] as [string, string]] : []),
    ]
    usage.replaceChildren(
      ...rows.flatMap(([key, value]) => {
        const term = document.createElement('dt')
        const description = document.createElement('dd')
        term.textContent = key
        description.textContent = value
        return [term, description]
      }),
    )
    renderedUsageValues = usageValues
    if (usagePanel.open) positionUsagePopover(meta, usage)
  }

  copy.addEventListener('click', () => {
    const finalText = state?.finalText
    if (!finalText) return
    const report = (copied: boolean) => {
      if (copied) feedback.report('已复制', 1600)
      else feedback.report('复制失败')
    }
    const fallback = () => report(legacyCopy(finalText))
    const write = globalThis.navigator?.clipboard?.writeText
    if (!write) return fallback()
    try {
      void Promise.resolve(write.call(globalThis.navigator.clipboard, finalText)).then(
        () => report(true),
        fallback,
      )
    } catch {
      fallback()
    }
  })
  fork.addEventListener('click', () => {
    const turn = state?.turn
    if (!turn?.forkable || !options.onFork || fork.disabled) return
    forkPending = true
    feedback.clear()
    render()
    void options
      .onFork(turn)
      .catch(() => feedback.report('分支失败，请重试。'))
      .finally(() => {
        forkPending = false
        render()
      })
  })
  usagePanel.addEventListener('toggle', () => {
    if (usagePanel.open) positionUsagePopover(meta, usage)
  })

  return {
    element,
    feedback,
    update(next) {
      state = next
      render()
    },
    dispose() {
      feedback.dispose()
    },
  }
}
