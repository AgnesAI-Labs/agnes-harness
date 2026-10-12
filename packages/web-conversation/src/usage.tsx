import type { UsageView } from '@agnes/protocol'
import type { LocaleVars } from '@agnes/web-client'
import { createRegionHost, createRegionRenderer, renderRegion, unmountRegion } from '@agnes/web-ui'
import { ConversationUsage, type CostNode, costDetails, costSummary } from '@agnes/web-ui/assistant-ui'
import { Fragment } from 'react'
import { flushSync } from 'react-dom'

export { type CostNode, costDetails, costSummary } from '@agnes/web-ui/assistant-ui'

/** Keeps the disclosure and its focus/expanded state through incremental updates. */
export function createCostDetails(
  parent: HTMLElement,
  t: (key: string, vars?: LocaleVars) => string,
): ((node: CostNode) => void) & { dispose(): void } {
  const host = createRegionHost(parent, 'div', 'conversation-content-host')
  let disposed = false
  const update = ((node: CostNode) => {
    if (disposed) return
    renderRegion(
      host,
      <details className="usage-disclosure call-usage">
        <summary aria-label={t('cost.callDetailsAria')}>{costSummary(node, t)}</summary>
        <dl className="usage-grid">
          {costDetails(node, t).map(([name, value]) => (
            <Fragment key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      </details>,
    )
  }) as ((node: CostNode) => void) & { dispose(): void }
  update.dispose = () => {
    if (disposed) return
    disposed = true
    queueMicrotask(() => unmountRegion(host))
  }
  return update
}

export type UsagePanelUpdater = ((usage: UsageView | undefined, connected: boolean) => void) & {
  dispose(): void
}

/** Synchronous compatibility root; production composer injects ConversationUsage directly. */
export function createUsagePanel(
  parent: HTMLElement,
  t?: (key: string, vars?: LocaleVars) => string,
): UsagePanelUpdater {
  const root = createRegionRenderer(parent)
  let disposed = false
  const update = ((usage, connected) => {
    if (disposed) return
    parent.hidden = !usage
    flushSync(() =>
      root.render(<ConversationUsage usage={usage} connected={connected} {...(t ? { t } : {})} />),
    )
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
