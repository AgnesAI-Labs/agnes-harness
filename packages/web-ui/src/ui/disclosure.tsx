import {
  type ButtonHTMLAttributes,
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { Icon } from './icon.js'

const REQUEST = 'agh:disclosure-request'

/**
 * True inside a surface that already draws an outline (a grouped card, a list row, an open
 * disclosure). A collapsible section rendered there is a row of that surface, never a second card.
 */
export const NestedSurfaceContext = createContext(false)

/** Whether the disclosure rendered at this element is showing its content. */
export const isDisclosureOpen = (root: Element | null | undefined): boolean =>
  root?.getAttribute('data-open') === 'true'

/**
 * Ask the disclosure rendered at this element to open or close, for a controller that must reveal
 * a field before it moves focus there. The change is committed before this returns.
 */
export function setDisclosureOpen(root: Element, open: boolean): void {
  root.dispatchEvent(new CustomEvent(REQUEST, { detail: open }))
}

export type DisclosureProps = Omit<HTMLAttributes<HTMLDivElement>, 'summary'> & {
  [key: `data-${string}`]: string | number | boolean | undefined
} & {
  /** The always-visible row that opens and closes the content. */
  summary: ReactNode
  /** Attributes of the summary button, such as its accessible name, class or test id. */
  summaryProps?: ButtonHTMLAttributes<HTMLButtonElement> & { [key: `data-${string}`]: string | undefined }
  summaryRef?: Ref<HTMLButtonElement>
  /** Controlled state. Without it the disclosure keeps whatever the reader last chose. */
  open?: boolean | undefined
  /** Initial state of an uncontrolled disclosure. */
  defaultOpen?: boolean
  /** Reports each change the reader makes: the summary, Escape or a click outside. */
  onOpenChange?: (open: boolean) => void
  /** A floating panel rather than a section: a click outside or Escape closes it. */
  dismissible?: boolean
  /**
   * Shared presentation: one chevron beside the title, as a quiet text toggle (`plain`), a
   * divided list row (`row`) or a grouped card whose header opens its content in place (`card`).
   * Without it the summary is the small marker followed by what the caller wrote; a caller with
   * its own indicator hides `.agh-disclosure-marker`.
   */
  variant?: 'plain' | 'row' | 'card'
  /** A leading icon tile; shown by the `row` and `card` presentations. */
  icon?: ReactNode
  /** One line beside the title that states the current value while the content is closed. */
  meta?: ReactNode
  /** One muted line under the title of a `card` that says what the section is for. */
  description?: ReactNode
}

/**
 * The one collapsible section of the product: a button that names the section and the region it
 * shows. The root carries `data-open`; the content stays mounted while closed, so what the reader
 * typed or selected inside survives a collapse.
 */
export const Disclosure = forwardRef<HTMLDivElement, DisclosureProps>(function Disclosure(
  {
    className,
    summary,
    summaryProps,
    summaryRef,
    open: controlled,
    defaultOpen = false,
    onOpenChange,
    dismissible = false,
    variant,
    icon,
    meta,
    description,
    children,
    ...props
  },
  forwarded,
) {
  const [own, setOwn] = useState(defaultOpen)
  const open = controlled ?? own
  const contentId = useId()
  const titleId = useId()
  const metaId = useId()
  const descriptionId = useId()
  const shown = (node: ReactNode) => node !== undefined && node !== null && node !== false
  const valued = !!variant && shown(meta)
  const explained = variant === 'card' && shown(description)
  const describedBy = [explained && descriptionId, valued && metaId].filter(Boolean).join(' ')
  const root = useRef<HTMLDivElement | null>(null)
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      root.current = node
      if (typeof forwarded === 'function') forwarded(node)
      else if (forwarded) forwarded.current = node
    },
    [forwarded],
  )
  const change = useCallback(
    (next: boolean) => {
      setOwn(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )
  useEffect(() => {
    const element = root.current
    if (!element) return
    const request = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail
      if (event.target === element && typeof next === 'boolean' && next !== open)
        flushSync(() => change(next))
    }
    element.addEventListener(REQUEST, request)
    return () => element.removeEventListener(REQUEST, request)
  }, [open, change])
  useEffect(() => {
    if (!dismissible || !open) return
    const doc = root.current?.ownerDocument
    if (!doc) return
    const outside = (event: Event) => {
      // Committed at once: whatever the click lands on next sees the panel already closed.
      if (root.current && !event.composedPath().includes(root.current)) flushSync(() => change(false))
    }
    doc.addEventListener('click', outside)
    return () => doc.removeEventListener('click', outside)
  }, [dismissible, open, change])
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anywhere inside closes a dismissible panel.
    <div
      {...props}
      ref={setRoot}
      data-variant={variant}
      data-open={String(open)}
      className={['agh-disclosure', className].filter(Boolean).join(' ')}
      onKeyDown={(event) => {
        props.onKeyDown?.(event)
        if (!dismissible || !open || event.key !== 'Escape' || event.defaultPrevented) return
        event.stopPropagation()
        change(false)
        root.current?.querySelector<HTMLElement>(':scope > .agh-disclosure-summary')?.focus()
      }}
    >
      <button
        type="button"
        {...summaryProps}
        ref={summaryRef}
        className={['agh-disclosure-summary', summaryProps?.className].filter(Boolean).join(' ')}
        aria-expanded={open}
        aria-controls={contentId}
        // The title names the section; its current value is a description, so the name stays stable.
        aria-labelledby={describedBy && !summaryProps?.['aria-label'] ? titleId : undefined}
        aria-describedby={describedBy || undefined}
        onClick={(event) => {
          summaryProps?.onClick?.(event)
          if (!event.defaultPrevented) change(!open)
        }}
      >
        {variant ? (
          <>
            {variant !== 'card' && <Icon name="chevron-right" className="agh-disclosure-chevron" />}
            {icon && variant !== 'plain' && (
              <span className="agh-icon-tile" aria-hidden="true">
                {icon}
              </span>
            )}
            {explained ? (
              <span className="agh-disclosure-heading">
                <span className="agh-disclosure-title" id={titleId}>
                  {summary}
                </span>
                <span className="agh-disclosure-description" id={descriptionId}>
                  {description}
                </span>
              </span>
            ) : (
              <span className="agh-disclosure-title" id={titleId}>
                {summary}
              </span>
            )}
            {valued && (
              <span className="agh-disclosure-meta" id={metaId}>
                {meta}
              </span>
            )}
            {variant === 'card' && <Icon name="chevron-right" className="agh-disclosure-chevron" />}
          </>
        ) : (
          <>
            <span className="agh-disclosure-marker" aria-hidden="true" />
            {summary}
          </>
        )}
      </button>
      <div
        id={contentId}
        className={variant ? 'agh-disclosure-content agh-disclosure-body' : 'agh-disclosure-content'}
        hidden={!open}
      >
        {variant ? (
          <NestedSurfaceContext.Provider value={true}>{children}</NestedSurfaceContext.Provider>
        ) : (
          children
        )}
      </div>
    </div>
  )
})
