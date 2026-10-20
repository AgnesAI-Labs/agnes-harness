import type { UITurn } from '@agnes/protocol'
import { Fragment, forwardRef } from 'react'
import type { Translate } from '../locales/index.js'
import { Disclosure } from '../ui/disclosure.js'
import { Icon } from '../ui/icon.js'
import { compact, costDetails } from './cost-format.js'

type Call = UITurn['usage']['calls'][number]

/** A call worth listing: it carried tokens, a charge, credits, or was interrupted. */
export const listedCall = (call: Call): boolean =>
  call.creditSource !== 'estimated' ||
  !call.tokens ||
  Object.values(call.tokens).some((value) => value !== 0) ||
  (call.billing?.usdMicros ?? 0) !== 0 ||
  (call.credits ?? 0) !== 0 ||
  !!call.interrupted

/** Every cost in the panel has the total's precision, so the column lines up. */
export const money = (usdMicros: number): string => `$${(usdMicros / 1e6).toFixed(6)}`

/**
 * Each call's bar against the most expensive call (which is full), and its share of the total
 * for the accessible label. Calls without a charge are compared by credits.
 */
export function callShares(
  calls: readonly Pick<Call, 'billing' | 'credits'>[],
): { width: number; percent: number }[] {
  const byCost = calls.some((call) => (call.billing?.usdMicros ?? 0) > 0)
  const value = (call: Pick<Call, 'billing' | 'credits'>) =>
    byCost ? (call.billing?.usdMicros ?? 0) : (call.credits ?? 0)
  const max = Math.max(0, ...calls.map(value))
  const total = calls.reduce((sum, call) => sum + value(call), 0)
  return calls.map((call) => ({
    width: max > 0 ? Math.round((value(call) / max) * 100) : 0,
    percent: total > 0 ? Math.round((value(call) / total) * 100) : 0,
  }))
}

const creditText = (amount: number) => `${amount.toFixed(8).replace(/\.?0+$/, '')} credits`

export interface TurnUsagePanelProps {
  turn: UITurn
  model: string | undefined
  duration: string | undefined
  /** Only once the answer settled; a running answer shows nothing here. */
  settled: boolean
  t: Translate
}

/**
 * The answer's usage, read top-down: what it was (model, time), what it cost, its tokens, then
 * each model call on demand. Every value is one the turn already carries.
 */
export const TurnUsagePanel = forwardRef<HTMLDivElement, TurnUsagePanelProps>(function TurnUsagePanel(
  { turn, model, duration, settled, t },
  ref,
) {
  const { totals, cost, credits, billingComplete } = turn.usage
  const source = (value: 'gateway' | 'estimated') =>
    t(value === 'estimated' ? 'cost.source.estimated' : 'cost.source.gateway')
  const calls = turn.usage.calls.filter(listedCall)
  const titleCalls = calls.filter((call) => call.purpose === 'title').length
  const amount = cost
    ? {
        value: money(cost.usdMicros),
        tag: `${source(cost.source)}${cost.subscription ? t('turnactions.subscription') : ''}${billingComplete ? '' : t('turnactions.billingPartial')}`,
      }
    : credits
      ? {
          value: creditText(credits.amount),
          tag: `${source(credits.source)}${credits.complete ? '' : t('turnactions.creditsPartial')}`,
        }
      : undefined
  // Credits beside a cost are a quiet note; their source only when it differs from the cost's.
  const creditNote =
    cost && credits
      ? `${creditText(credits.amount)}${credits.source === cost.source ? '' : ` · ${source(credits.source)}`}${credits.complete ? '' : t('turnactions.creditsPartial')}`
      : undefined
  const cached = totals.cacheRead > 0 || totals.cacheWrite > 0
  const shares = callShares(calls)
  const chevron = <Icon name="chevron-right" className="turn-usage-chevron" />
  return (
    <div ref={ref} className="turn-usage-grid turn-usage-panel" data-testid="turn-usage-panel">
      {settled && (
        <>
          <header className="turn-usage-head">
            <span className="turn-usage-title">{t('turnactions.usage.title')}</span>
            {model && <span className="turn-usage-model">{model}</span>}
            {duration && <span className="turn-usage-took">{t('turnactions.usage.took', { duration })}</span>}
          </header>
          {amount && (
            <p className="turn-usage-cost" data-testid="turn-usage-cost">
              <span className="turn-usage-amount">{amount.value}</span>
              <span className="turn-usage-tag">{amount.tag}</span>
              {creditNote && <span className="turn-usage-credits">{creditNote}</span>}
            </p>
          )}
          <dl className="turn-usage-tokens" data-cells={cached ? 3 : 2}>
            <div>
              <dt>{t('turnactions.usage.input')}</dt>
              <dd>{totals.input.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('turnactions.usage.output')}</dt>
              <dd>{totals.output.toLocaleString()}</dd>
            </div>
            {cached && (
              <div>
                <dt>{t('turnactions.usage.cache')}</dt>
                <dd>{`${totals.cacheRead.toLocaleString()} / ${totals.cacheWrite.toLocaleString()}`}</dd>
              </div>
            )}
          </dl>
          {calls.length === 1 && calls[0] && (
            // One call needs no table; its own details stay one click away.
            <Disclosure
              className="turn-usage-calls call-usage"
              summary={
                <span className="turn-usage-calls-title">
                  {chevron}
                  <span>
                    {calls[0].purpose === 'title'
                      ? t('turnactions.usage.backgroundTitleAria')
                      : t('turnactions.usage.callDetails')}
                  </span>
                </span>
              }
              summaryProps={{ 'data-testid': 'turn-usage-call-details', 'aria-label': t('cost.detailsAria') }}
            >
              <div className="turn-usage-calls-body">
                <CallDetails call={calls[0]} t={t} />
              </div>
            </Disclosure>
          )}
          {calls.length > 1 && (
            <Disclosure
              className="turn-usage-calls"
              summary={
                <span className="turn-usage-calls-title">
                  {chevron}
                  <span>
                    {t('turnactions.usage.calls', { count: calls.length })}
                    {titleCalls > 0 ? t('turnactions.usage.includesTitles', { count: titleCalls }) : ''}
                  </span>
                  <span className="turn-usage-calls-hint" data-when="closed">
                    {t('turnactions.usage.callsShow')}
                  </span>
                  <span className="turn-usage-calls-hint" data-when="open">
                    {t('turnactions.usage.callsHide')}
                  </span>
                </span>
              }
              summaryProps={{ 'data-testid': 'turn-usage-calls' }}
            >
              <div className="turn-usage-calls-body">
                <div className="turn-call-row turn-call-head" aria-hidden="true">
                  <span>{'#'}</span>
                  <span>{t('turnactions.usage.input')}</span>
                  <span>{t('turnactions.usage.output')}</span>
                  <span>{t('turnactions.usage.cost')}</span>
                  <span />
                </div>
                {calls.map((call, index) => (
                  <Disclosure
                    key={call.id}
                    className="turn-call"
                    data-testid={`turn-call-${index + 1}`}
                    summary={
                      <span className="turn-call-row">
                        <span className="turn-call-n">
                          {chevron}
                          {call.purpose === 'title'
                            ? t('turnactions.usage.backgroundTitle')
                            : calls.slice(0, index + 1).filter((entry) => entry.purpose !== 'title').length}
                        </span>
                        <span>{call.tokens ? compact(call.tokens.input) : '—'}</span>
                        <span>{call.tokens ? compact(call.tokens.output) : '—'}</span>
                        <span>
                          {call.billing
                            ? money(call.billing.usdMicros)
                            : call.credits !== undefined
                              ? creditText(call.credits)
                              : '—'}
                        </span>
                        <span
                          className="turn-call-share"
                          role="img"
                          aria-label={t('turnactions.usage.share', {
                            percent: shares[index]?.percent ?? 0,
                          })}
                        >
                          <i style={{ width: `${shares[index]?.width ?? 0}%` }} />
                        </span>
                      </span>
                    }
                    summaryProps={{
                      'aria-label':
                        call.purpose === 'title'
                          ? t('turnactions.usage.backgroundTitleAria')
                          : t('turnactions.usage.callAria', {
                              index: calls.slice(0, index + 1).filter((entry) => entry.purpose !== 'title')
                                .length,
                            }),
                    }}
                  >
                    <CallDetails call={call} t={t} />
                  </Disclosure>
                ))}
              </div>
            </Disclosure>
          )}
        </>
      )}
    </div>
  )
})

function CallDetails({ call, t }: { call: Call; t: Translate }) {
  return (
    <dl className="usage-grid">
      {costDetails({ ...call, kind: 'cost', source: call.creditSource }, t, money).map(([name, value]) => (
        <Fragment key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}
