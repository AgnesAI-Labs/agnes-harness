import type { UITurn } from '@agnes/protocol'
import { Fragment, forwardRef, type ReactNode } from 'react'
import type { Translate } from '../locales/index.js'
import { Disclosure } from '../ui/disclosure.js'
import { compact, costDetails, usd } from './cost-format.js'

type Call = UITurn['usage']['calls'][number]

/** A call worth listing: it carried tokens, a charge, credits, or was interrupted. */
export const listedCall = (call: Call): boolean =>
  call.creditSource !== 'estimated' ||
  !call.tokens ||
  Object.values(call.tokens).some((value) => value !== 0) ||
  (call.billing?.usdMicros ?? 0) !== 0 ||
  (call.credits ?? 0) !== 0 ||
  !!call.interrupted

const creditText = (amount: number) => `${amount.toFixed(8).replace(/\.?0+$/, '')} credits`

export interface TurnUsagePanelProps {
  turn: UITurn
  model: string | undefined
  duration: string | undefined
  /** Only once the answer settled; a running answer shows nothing here. */
  settled: boolean
  t: Translate
  /** Optional last line of the panel, after the explanation (for example «view in trace»). */
  footer?: ReactNode
}

/**
 * The answer's usage, read top-down: what it was (model, time), what it cost, its tokens, then
 * each model call on demand. Every value is one the turn already carries.
 */
export const TurnUsagePanel = forwardRef<HTMLDivElement, TurnUsagePanelProps>(function TurnUsagePanel(
  { turn, model, duration, settled, t, footer },
  ref,
) {
  const { totals, cost, credits, billingComplete } = turn.usage
  const source = (value: 'gateway' | 'estimated') =>
    t(value === 'estimated' ? 'cost.source.estimated' : 'cost.source.gateway')
  const calls = turn.usage.calls.filter(listedCall)
  const estimated =
    cost?.source === 'estimated' ||
    (!cost && credits?.source === 'estimated') ||
    calls.some((call) => call.billing?.source === 'estimated')
  const amount = cost
    ? {
        value: `$${(cost.usdMicros / 1e6).toFixed(6)}`,
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
  const charge = (call: Call) => call.billing?.usdMicros ?? 0
  const total = calls.reduce((sum, call) => sum + charge(call), 0)
  const creditTotal = calls.reduce((sum, call) => sum + (call.credits ?? 0), 0)
  const share = (call: Call) =>
    total > 0 ? charge(call) / total : creditTotal > 0 ? (call.credits ?? 0) / creditTotal : 0
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
              summary={<span className="turn-usage-calls-title">{t('turnactions.usage.callDetails')}</span>}
              summaryProps={{ 'data-testid': 'turn-usage-call-details', 'aria-label': t('cost.detailsAria') }}
            >
              <CallDetails call={calls[0]} t={t} />
            </Disclosure>
          )}
          {calls.length > 1 && (
            <Disclosure
              className="turn-usage-calls"
              summary={
                <span className="turn-usage-calls-title">
                  <span>{t('turnactions.usage.calls', { count: calls.length })}</span>
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
                      <span>{index + 1}</span>
                      <span>{call.tokens ? compact(call.tokens.input) : '—'}</span>
                      <span>{call.tokens ? compact(call.tokens.output) : '—'}</span>
                      <span>
                        {call.billing
                          ? usd(call.billing.usdMicros)
                          : call.credits !== undefined
                            ? creditText(call.credits)
                            : '—'}
                      </span>
                      <span
                        className="turn-call-share"
                        role="img"
                        aria-label={t('turnactions.usage.share', {
                          percent: Math.round(share(call) * 100),
                        })}
                      >
                        <i style={{ width: `${Math.round(share(call) * 100)}%` }} />
                      </span>
                    </span>
                  }
                  summaryProps={{
                    'aria-label': t('turnactions.usage.callAria', { index: index + 1 }),
                  }}
                >
                  <CallDetails call={call} t={t} />
                </Disclosure>
              ))}
            </Disclosure>
          )}
          {(estimated || footer) && (
            <footer className="turn-usage-foot">
              {estimated && <p>{t('turnactions.usage.estimatedNote')}</p>}
              {footer && <p className="turn-usage-foot-action">{footer}</p>}
            </footer>
          )}
        </>
      )}
    </div>
  )
})

function CallDetails({ call, t }: { call: Call; t: Translate }) {
  return (
    <dl className="usage-grid">
      {costDetails({ ...call, kind: 'cost', source: call.creditSource }, t).map(([name, value]) => (
        <Fragment key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}
