import { type DetailsHTMLAttributes, forwardRef, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import { Icon } from './icon.js'

export type DisclosureProps = Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'open' | 'summary'> & {
  [key: `data-${string}`]: string | number | boolean | undefined
} & {
  /** The always-visible row that opens and closes the content. */
  summary: ReactNode
  /** Attributes of the summary row, such as its accessible name, class or test id. */
  summaryProps?: HTMLAttributes<HTMLElement> & { [key: `data-${string}`]: string | undefined }
  summaryRef?: Ref<HTMLElement>
  /** Controlled state. Without it the disclosure keeps whatever the reader last chose. */
  open?: boolean | undefined
  /** Initial state of an uncontrolled disclosure. */
  defaultOpen?: boolean
  /** Reports every change of the open state, whether the reader or the owner caused it. */
  onOpenChange?: (open: boolean) => void
  /**
   * Shared presentation: one chevron in place of the browser marker, as a quiet text toggle
   * (`plain`) or a divided list row (`row`). Without it the summary is rendered as written and
   * the caller styles it.
   */
  variant?: 'plain' | 'row'
}

/**
 * The one collapsible section of the product. It keeps the native disclosure semantics: the
 * summary is focusable, Enter and Space toggle it, and find-in-page can open it.
 */
export const Disclosure = forwardRef<HTMLDetailsElement, DisclosureProps>(function Disclosure(
  {
    className,
    summary,
    summaryProps,
    summaryRef,
    open,
    defaultOpen,
    onOpenChange,
    onToggle,
    variant,
    children,
    ...props
  },
  ref,
) {
  return (
    <details
      {...props}
      ref={ref}
      data-variant={variant}
      className={['agh-disclosure', className].filter(Boolean).join(' ')}
      open={open ?? (defaultOpen || undefined)}
      onToggle={
        onToggle || onOpenChange
          ? (event) => {
              onToggle?.(event)
              onOpenChange?.(event.currentTarget.open)
            }
          : undefined
      }
    >
      <summary {...summaryProps} ref={summaryRef}>
        {variant ? (
          <>
            <Icon name="chevron-right" className="agh-disclosure-chevron" />
            <span className="agh-disclosure-title">{summary}</span>
          </>
        ) : (
          summary
        )}
      </summary>
      {variant ? <div className="agh-disclosure-body">{children}</div> : children}
    </details>
  )
})
