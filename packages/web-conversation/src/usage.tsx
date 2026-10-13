import type { LocaleVars } from '@agnes/web-client'
import { createRegionHost, renderRegion, unmountRegion } from '@agnes/web-ui'
import { type CostNode, costDetails, costSummary } from '@agnes/web-ui/conversation'
import { Fragment } from 'react'

export { type CostNode, costDetails, costSummary } from '@agnes/web-ui/conversation'

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
