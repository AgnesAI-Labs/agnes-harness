import { Fragment } from 'react'
import { type CostNode, costDetails, costSummary } from './cost-format.js'

/** Native disclosure state and focus belong to the user throughout same-ID updates. */
export function ConversationCost({ node }: { node: CostNode }) {
  return (
    <details className="usage-disclosure call-usage">
      <summary aria-label="查看本次调用用量明细">{costSummary(node)}</summary>
      <dl className="usage-grid">
        {costDetails(node).map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}
