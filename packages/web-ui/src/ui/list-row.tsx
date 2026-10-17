import { type HTMLAttributes, type ReactNode, useRef } from 'react'
import { Button } from './button.js'
import { NestedSurfaceContext } from './disclosure.js'

export type ListRowProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: ReactNode
  titleLabel?: string
  titleClassName?: string
  icon?: ReactNode
  description?: ReactNode
  meta?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  onOpen?: () => void
  /** Compact file row using the shared deliverable card tokens and skin hooks. */
  variant?: 'default' | 'file'
}
/** The title is a real button. Row actions never trigger the detail action. */
export function ListRow({
  title,
  titleClassName,
  titleLabel,
  icon,
  description,
  meta,
  status,
  actions,
  onOpen,
  variant = 'default',
  children,
  className,
  ...props
}: ListRowProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const file = variant === 'file'
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the real title button owns keyboard activation; row key handlers would also activate trailing actions.
    <article
      {...props}
      className={[file ? 'deliverable-row' : 'agh-list-row', className].filter(Boolean).join(' ')}
      onClick={(event) => {
        props.onClick?.(event)
        if (
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node) &&
          !(event.target as Element).closest(
            'button, a, input, select, textarea, details, [role="button"], [role="combobox"], [role="option"], [role="listbox"]',
          )
        ) {
          trigger.current?.focus()
          onOpen?.()
        }
      }}
    >
      {icon && (
        <div className={file ? undefined : 'agh-list-row-icon'} aria-hidden="true">
          {icon}
        </div>
      )}
      <div className={file ? 'deliverable-text' : 'agh-list-row-copy'}>
        <div className={file ? undefined : 'agh-list-row-heading'}>
          <h3
            title={typeof title === 'string' ? title : undefined}
            className={file ? 'deliverable-name' : undefined}
          >
            {onOpen ? (
              <Button
                ref={trigger}
                appearance="ghost"
                aria-label={titleLabel}
                className={['agh-list-row-title', titleClassName].filter(Boolean).join(' ')}
                onClick={onOpen}
              >
                {title}
              </Button>
            ) : (
              title
            )}
          </h3>
          {status}
        </div>
        {description && <p className={file ? 'deliverable-meta' : undefined}>{description}</p>}
        {meta && <div className={file ? 'deliverable-meta' : 'agh-meta'}>{meta}</div>}
        <NestedSurfaceContext.Provider value={true}>{children}</NestedSurfaceContext.Provider>
      </div>
      {actions && <div className={file ? 'deliverable-actions' : 'agh-list-row-actions'}>{actions}</div>}
    </article>
  )
}
