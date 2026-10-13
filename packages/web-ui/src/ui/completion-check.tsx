import type { ReactNode } from 'react'
import { Icon } from './icon.js'

export type CompletionCheckProps = {
  /** What finished, for assistive technology (for example "Completed"). */
  label: string
  /** Optional quiet detail such as a duration; rendered with tabular numerals. */
  children?: ReactNode
  className?: string
}

/** The light mark a finished turn or step leaves behind: a check and, optionally, how long it took. */
export function CompletionCheck({ label, children, className }: CompletionCheckProps) {
  return (
    <span className={['agh-completion', className].filter(Boolean).join(' ')}>
      <Icon name="check" size={16} />
      <span className="agh-visually-hidden">{label}</span>
      {children === undefined || children === null ? null : (
        <span className="agh-completion-detail">{children}</span>
      )}
    </span>
  )
}
