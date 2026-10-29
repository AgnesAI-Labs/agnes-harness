import type { ReactNode } from 'react'
import type { StateTone } from './state-lights.js'

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
      className={['agnes-ui-badge', 'agh-tag', className].filter(Boolean).join(' ')}
      data-tone={tone}
      style={{
        color: `var(${tone === 'ok' ? '--agnes-status-success-text' : tone === 'warn' ? '--agnes-status-warning-text' : tone === 'bad' ? '--agnes-status-danger-text' : '--agnes-text-secondary'})`,
      }}
    >
      {children}
    </span>
  )
}
