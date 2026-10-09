import type { ReactNode } from 'react'
import type { StateTone } from './state-lights.js'

const colors: Record<StateTone, string> = {
  ok: 'var(--agnes-status-success-text)',
  warn: 'var(--agnes-status-warning-text)',
  bad: 'var(--agnes-status-danger-text)',
  off: 'var(--agnes-text-secondary)',
  unknown: 'var(--agnes-text-secondary)',
}
/** Text remains the state indicator; semantic colors are supplementary and theme-owned. */
export function Badge({
  children,
  tone = 'off',
  className,
}: {
  children: ReactNode
  tone?: StateTone
  className?: string
}) {
  return (
    <span
      className={['agnes-ui-badge', className].filter(Boolean).join(' ')}
      data-tone={tone}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        border: '1px solid var(--agnes-line-primary)',
        borderRadius: 'var(--radius-full)',
        padding: '0.125rem 0.5rem',
        fontSize: 'var(--font-size-xs)',
        lineHeight: 1.4,
        color: colors[tone],
        background: 'var(--agnes-bg-surface)',
      }}
    >
      {children}
    </span>
  )
}
