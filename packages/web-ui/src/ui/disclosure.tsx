import { type DetailsHTMLAttributes, forwardRef, type HTMLAttributes, type ReactNode, type Ref } from 'react'

export type DisclosureProps = Omit<
  DetailsHTMLAttributes<HTMLDetailsElement>,
  'open' | 'onToggle' | 'summary'
> & {
  /** The always-visible row that opens and closes the content. */
  summary: ReactNode
  /** Attributes of the summary row, such as its accessible name, class or test id. */
  summaryProps?: HTMLAttributes<HTMLElement> & { [key: `data-${string}`]: string | undefined }
  summaryRef?: Ref<HTMLElement>
  /** Controlled state. Without it the disclosure keeps whatever the reader last chose. */
  open?: boolean
  /** Initial state of an uncontrolled disclosure. */
  defaultOpen?: boolean
  /** Reports every change of the open state, whether the reader or the owner caused it. */
  onOpenChange?: (open: boolean) => void
}

/**
 * The one collapsible section of the product. It keeps the native disclosure semantics: the
 * summary is focusable, Enter and Space toggle it, and find-in-page can open it.
 */
export const Disclosure = forwardRef<HTMLDetailsElement, DisclosureProps>(function Disclosure(
  { className, summary, summaryProps, summaryRef, open, defaultOpen, onOpenChange, children, ...props },
  ref,
) {
  return (
    <details
      {...props}
      ref={ref}
      className={['agh-disclosure', className].filter(Boolean).join(' ')}
      open={open ?? (defaultOpen || undefined)}
      onToggle={onOpenChange ? (event) => onOpenChange(event.currentTarget.open) : undefined}
    >
      <summary {...summaryProps} ref={summaryRef}>
        {summary}
      </summary>
      {children}
    </details>
  )
})
