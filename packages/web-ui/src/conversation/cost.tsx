import { Fragment } from 'react'
import { fallbackT, type Translate } from '../locales/index.js'
import { Disclosure } from '../ui/disclosure.js'
import { type CostNode, costDetails, costSummary } from './cost-format.js'

/** Native disclosure state and focus belong to the user throughout same-ID updates. */
export function ConversationCost({ node, t = fallbackT }: { node: CostNode; t?: Translate }) {
  return (
    <Disclosure
      className="usage-disclosure call-usage"
      summary={costSummary(node, t)}
      summaryProps={{ 'aria-label': t('cost.detailsAria') }}
    >
      <dl className="usage-grid">
        {costDetails(node, t).map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </Disclosure>
  )
}
