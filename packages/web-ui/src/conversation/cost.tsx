import { Fragment } from 'react'
import { type CostNode, costDetails, costSummary } from './cost-format.js'
import { fallbackT, type Translate } from '../locales/index.js'

/** Native disclosure state and focus belong to the user throughout same-ID updates. */
export function ConversationCost({ node, t = fallbackT }: { node: CostNode; t?: Translate }) {
  return (
    <details className="usage-disclosure call-usage">
      <summary aria-label={t('cost.detailsAria')}>{costSummary(node, t)}</summary>
      <dl className="usage-grid">
        {costDetails(node, t).map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}
