import type { UsageView } from '@agnes/protocol'
import { type CSSProperties, Fragment, useLayoutEffect, useRef } from 'react'

export type ConversationUsageProps = { usage: UsageView | undefined; connected: boolean }
const compact = (n: number) =>
  n < 1000 ? String(n) : `${(n / (n >= 1e6 ? 1e6 : 1000)).toFixed(1)}${n >= 1e6 ? 'M' : 'K'}`
const count = (n: number) => n.toLocaleString('en-US')

/** The host owns visibility; native disclosure state belongs to the reader until usage clears. */
export function ConversationUsage({ usage, connected }: ConversationUsageProps) {
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
  const stale = connected ? '' : ' · 上次同步'
  const caption = usage
    ? `约 ${compact(usage.context.tokens)} / ${compact(usage.context.window)}${stale}`
    : ''
  const summary = usage
    ? `上下文约 ${compact(usage.context.tokens)} / ${compact(usage.context.window)} · ${pct}%${stale}`
    : ''
  const rows: Array<[string, string]> = usage
    ? [
        ['上下文占用', `${count(usage.context.tokens)} Token`],
        ['模型窗口', `${count(usage.context.window)} Token`],
        ...(usage.model.maxTokens
          ? [['最大输出上限', `${count(usage.model.maxTokens)} Token`] as [string, string]]
          : []),
        ['自动整理上下文', usage.context.autoCompact ? '已启用' : '未启用'],
      ]
    : []
  return (
    <details
      ref={details}
      className="usage-disclosure session-usage"
      hidden={!usage}
      data-pressure={usage ? (Number(pct) > 90 ? 'high' : Number(pct) > 70 ? 'medium' : 'normal') : undefined}
    >
      <summary aria-label={usage ? `查看${summary}` : '查看会话上下文占用'} title="上下文用量">
        <span className="usage-ring" aria-hidden="true" style={{ '--usage-pct': fill } as CSSProperties} />
        <span className="usage-summary-label">{summary}</span>
      </summary>
      <div className="usage-popover">
        <div className="usage-popover-head">
          <p className="usage-popover-title">上下文已用</p>
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
        <p className="usage-note">
          上下文为后台估算，包含当前保留的对话等内容；模型窗口与输出上限来自模型配置。
        </p>
      </div>
    </details>
  )
}
