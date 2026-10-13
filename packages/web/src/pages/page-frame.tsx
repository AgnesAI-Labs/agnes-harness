import type { ReactNode } from 'react'

/**
 * The full-page template for a home entry: a centred column with a header (title, one sentence,
 * one primary action on the right), optional tabs, then sections.
 */
export function HomePageFrame({
  id,
  title,
  description,
  actions,
  breadcrumb,
  tabs,
  children,
}: {
  /** Names the page for tests and skins: `home-page-<id>`. */
  id: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** A capability page shows where it sits, e.g. "Plugins › Web search". */
  breadcrumb?: ReactNode
  tabs?: ReactNode
  children?: ReactNode
}) {
  const headingId = `home-page-${id}-title`
  return (
    <article className="home-page" data-testid={`home-page-${id}`} aria-labelledby={headingId}>
      {breadcrumb && <nav className="home-page-breadcrumb">{breadcrumb}</nav>}
      <header className="home-page-header">
        <div className="home-page-heading">
          <h1 id={headingId}>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="home-page-actions">{actions}</div>}
      </header>
      {tabs && <div className="home-page-tabs">{tabs}</div>}
      <div className="home-page-body">{children}</div>
    </article>
  )
}

/** One titled group of rows or cards on a full page. */
export function HomePageSection({
  title,
  actions,
  children,
}: {
  title?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="home-page-section">
      {(title || actions) && (
        <div className="home-page-section-heading">
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}
