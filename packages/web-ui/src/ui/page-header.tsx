import type { HTMLAttributes, ReactNode } from 'react'

export type PageHeaderProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: ReactNode
  /** One sentence that says what the page is for. */
  description?: ReactNode
  /** The page's actions; at most one of them is primary. */
  actions?: ReactNode
  /** Id of the heading, for `aria-labelledby` on the page region. */
  headingId?: string
}

/** The head of a full page: a large title, one line of description and the page actions. */
export function PageHeader({ title, description, actions, headingId, className, ...props }: PageHeaderProps) {
  return (
    <header {...props} className={['agh-page-header', className].filter(Boolean).join(' ')}>
      <div className="agh-page-header-copy">
        <h1 id={headingId} className="agh-page-title">
          {title}
        </h1>
        {description ? <p className="agh-page-description">{description}</p> : null}
      </div>
      {actions ? <div className="agh-page-header-actions">{actions}</div> : null}
    </header>
  )
}
