import { type HTMLAttributes, type ReactNode, useRef } from 'react'
import { Button } from './button.js'

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
  children,
  className,
  ...props
}: ListRowProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the real title button owns keyboard activation; row key handlers would also activate trailing actions.
    <article
      {...props}
      className={['agh-list-row', className].filter(Boolean).join(' ')}
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
        <div className="agh-list-row-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="agh-list-row-copy">
        <div className="agh-list-row-heading">
          <h3>
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
        {description && <p>{description}</p>}
        {meta && <div className="agh-meta">{meta}</div>}
        {children}
      </div>
      {actions && <div className="agh-list-row-actions">{actions}</div>}
    </article>
  )
}
