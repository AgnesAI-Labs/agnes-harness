import type { UsageView } from '@agnes/protocol'
import { ConversationUsage, type CostNode, costDetails, costSummary } from '@agnes/web-ui/assistant-ui'

import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

export { type CostNode, costDetails, costSummary } from '@agnes/web-ui/assistant-ui'

type Rows = Array<[string, string]>

function fillRows(list: HTMLDListElement, rows: Rows): void {
  list.replaceChildren(
    ...rows.flatMap(([name, value]) => {
      const term = document.createElement('dt')
      const detail = document.createElement('dd')
      term.textContent = name
      detail.textContent = value
      return [term, detail]
    }),
  )
}

/** Keeps the native disclosure and its focus/expanded state through incremental updates. */
export function createCostDetails(parent: HTMLElement): (node: CostNode) => void {
  const details = document.createElement('details')
  details.className = 'usage-disclosure call-usage'
  const summary = document.createElement('summary')
  summary.setAttribute('aria-label', '查看本次调用用量明细')
  const list = document.createElement('dl')
  list.className = 'usage-grid'
  details.append(summary, list)
  parent.append(details)
  return (node) => {
    summary.textContent = costSummary(node)
    fillRows(list, costDetails(node))
  }
}

export type UsagePanelUpdater = ((usage: UsageView | undefined, connected: boolean) => void) & {
  dispose(): void
}

/** Synchronous compatibility root; production composer injects ConversationUsage directly. */
export function createUsagePanel(parent: HTMLElement): UsagePanelUpdater {
  const root = createRoot(parent)
  let disposed = false
  const update = ((usage, connected) => {
    if (disposed) return
    parent.hidden = !usage
    flushSync(() => root.render(createElement(ConversationUsage, { usage, connected })))
  }) as UsagePanelUpdater
  update.dispose = () => {
    if (disposed) return
    disposed = true
    flushSync(() => root.unmount())
    parent.hidden = true
  }
  update(undefined, false)
  return update
}
