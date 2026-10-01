import type { UsageView } from '@agnes/protocol'
import { type CSSProperties, Fragment, useLayoutEffect, useRef } from 'react'
import { fallbackT, type Translate } from '../locales/index.js'

export type ConversationUsageProps = {
  usage: UsageView | undefined
  connected: boolean
  /** Locale-bound translate injected by the host; render-time lookup only. */
  t?: Translate
}
const compact = (n: number) =>
  n < 1000 ? String(n) : `${(n / (n >= 1e6 ? 1e6 : 1000)).toFixed(1)}${n >= 1e6 ? 'M' : 'K'}`
const count = (n: number) => n.toLocaleString('en-US')

/** The host owns visibility; native disclosure state belongs to the reader until usage clears. */
export function ConversationUsage({ usage, connected, t = fallbackT }: ConversationUsageProps) {
  const details = useRef<HTMLDetailsElement>(null)
  useLayoutEffect(() => {
    const element = details.current
    if (!element) return
    const doc = element.ownerDocument
    const dismiss = (event: Event) => {
      if (element.open && !event.composedPath().includes(element)) element.open = false
    }
    doc.addEventListener('click', dismiss)
    return () => doc.removeEventListener('click', dismiss)
  }, [])
  useLayoutEffect(() => {
    if (!usage && details.current) details.current.open = false
  }, [usage])

  const pct = usage ? ((usage.context.tokens / usage.context.window) * 100).toFixed(1) : ''
  const fill = `${Math.min(100, Number(pct))}%`
  const stale = connected ? '' : t('usage.stale')
  const caption = usage
    ? t('usage.caption', { used: compact(usage.context.tokens), window: compact(usage.context.window), stale })
    : ''
  const summary = usage
    ? t('usage.summary', {
        used: compact(usage.context.tokens),
        window: compact(usage.context.window),
        pct,
        stale,
      })
    : ''
  const rows: Array<[string, string]> = usage
    ? [
        [t('usage.rows.context'), `${count(usage.context.tokens)} Token`],
        [t('usage.rows.window'), `${count(usage.context.window)} Token`],
        ...(usage.model.maxTokens
          ? [[t('usage.rows.maxOutput'), `${count(usage.model.maxTokens)} Token`] as [string, string]]
          : []),
        [t('usage.rows.autoCompact'), usage.context.autoCompact ? t('usage.enabled') : t('usage.disabled')],
      ]
    : []
  return (
    <details
      ref={details}
      className="usage-disclosure session-usage"
      hidden={!usage}
      data-pressure={usage ? (Number(pct) > 90 ? 'high' : Number(pct) > 70 ? 'medium' : 'normal') : undefined}
    >
      <summary
        aria-label={usage ? t('usage.viewAria', { summary }) : t('usage.viewAriaFallback')}
        title={t('usage.title')}
      >
        <span className="usage-ring" aria-hidden="true" style={{ '--usage-pct': fill } as CSSProperties} />
        <span className="usage-summary-label">{summary}</span>
      </summary>
      <div className="usage-popover">
        <div className="usage-popover-head">
          <p className="usage-popover-title">{t('usage.usedTitle')}</p>
          <p className="usage-context-value">{usage ? `${pct}%` : ''}</p>
          <p className="usage-context-caption">{caption}</p>
        </div>
        <div className="usage-bar" aria-hidden="true">
          <span style={{ width: fill }} />
        </div>
        <dl className="usage-grid">
          {rows.map(([name, value]) => (
            <Fragment key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="usage-note">{t('usage.note')}</p>
      </div>
    </details>
  )
}
