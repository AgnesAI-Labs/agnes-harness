import type { HTMLAttributes, ReactNode } from 'react'

export type EmptyStateProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  icon: ReactNode
  title: ReactNode
  /** Omitted when the title already says everything; an empty paragraph would add blank space. */
  description?: ReactNode
  /** At most one primary and one secondary action. */
  actions?: ReactNode
  help?: ReactNode
}
export function EmptyState({
  icon,
  title,
  description,
  actions,
  help,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <section {...props} className={['agh-empty-state', className].filter(Boolean).join(' ')}>
      <div className="agh-empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {actions && <div className="agh-empty-state-actions">{actions}</div>}
      {help && <div className="agh-empty-state-help">{help}</div>}
    </section>
  )
}
