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
    <span className={['agnes-ui-badge', 'agh-tag', className].filter(Boolean).join(' ')} data-tone={tone}>
      {children}
    </span>
  )
}
