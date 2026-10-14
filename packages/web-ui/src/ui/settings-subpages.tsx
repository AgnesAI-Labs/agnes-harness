import type { HTMLAttributes, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { fallbackT } from '../locales/index.js'
import { Icon } from './icon.js'
import type { IconName } from './icon-set.js'
import { IconTile } from './icon-tile.js'

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

/** The history entry a subpage adds; browser back pops to the depth it names. */
const HISTORY_KEY = 'agnesSettingsSubpage'

type SubpageFrame = {
  /** Open subpages, outermost first. */
  stack: readonly string[]
  open(id: string): void
  back(): void
  /** Where an open subpage puts its header and its body. */
  header: HTMLElement | null
  host(id: string): HTMLElement | null
}
const SubpageContext = createContext<SubpageFrame | undefined>(undefined)

function historyDepth(state: unknown): number {
  const depth = (state as Record<string, unknown> | null)?.[HISTORY_KEY]
  return typeof depth === 'number' ? depth : 0
}

/**
 * A settings page that can drill into subpages: `header` is the page's own header, shown while no
 * subpage is open. A subpage replaces the header and the body in the same dialog; 「‹ 返回」 and the
 * browser's back button return one level. The page body stays mounted, so its state survives.
 */
export function SettingsSubpageFrame({
  header,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & DataAttributes & { header: ReactNode }) {
  const [stack, setStack] = useState<readonly string[]>([])
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null)
  const [hosts, setHosts] = useState<Readonly<Record<string, HTMLElement>>>({})
  const pushed = useRef(0)
  const current = useRef(stack)
  current.current = stack
  const root = useRef<HTMLDivElement>(null)
  // Closing the dialog leaves its subpages: it opens again on the page itself.
  useEffect(() => {
    const dialog = root.current?.closest('dialog')
    if (!dialog) return
    const reset = () => {
      pushed.current = 0
      current.current = []
      setStack([])
    }
    dialog.addEventListener('close', reset)
    return () => dialog.removeEventListener('close', reset)
  }, [])
  useEffect(() => {
    const listener = (event: PopStateEvent) => {
      const depth = historyDepth(event.state)
      pushed.current = Math.min(pushed.current, depth)
      setStack((known) => {
        const next = depth < known.length ? known.slice(0, depth) : known
        current.current = next
        return next
      })
    }
    window.addEventListener('popstate', listener)
    return () => window.removeEventListener('popstate', listener)
  }, [])
  const open = useCallback((id: string) => {
    const known = current.current
    if (known.at(-1) === id) return
    const next = [...known.filter((entry) => entry !== id), id]
    current.current = next
    setStack(next)
    // One history entry per level, so the browser's back button leaves the subpage.
    try {
      history.pushState({ ...(history.state ?? {}), [HISTORY_KEY]: next.length }, '')
      pushed.current = next.length
    } catch {}
  }, [])
  const back = useCallback(() => {
    const depth = current.current.length
    if (depth > 0 && pushed.current === depth && historyDepth(history.state) === depth) {
      history.back()
      return
    }
    const next = current.current.slice(0, -1)
    current.current = next
    setStack(next)
  }, [])
  // One stable ref per subpage: a new callback each render would detach and attach it again.
  const hostRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const hostRef = (id: string) => {
    let ref = hostRefs.current.get(id)
    if (!ref) {
      ref = (node) =>
        setHosts((current) => {
          if (node ? current[id] === node : !current[id]) return current
          const next = { ...current }
          if (node) next[id] = node
          else delete next[id]
          return next
        })
      hostRefs.current.set(id, ref)
    }
    return ref
  }
  const frame = useMemo<SubpageFrame>(
    () => ({ stack, open, back, header: headerHost, host: (id) => hosts[id] ?? null }),
    [stack, open, back, headerHost, hosts],
  )
  const top = stack.at(-1)
  return (
    <SubpageContext.Provider value={frame}>
      <div
        {...props}
        ref={root}
        className={['agnes-settings-subpage-frame', props.className].filter(Boolean).join(' ')}
        data-subpage={top}
      >
        <div className="agnes-settings-subpage-main-header" hidden={!!top}>
          {header}
        </div>
        <div ref={setHeaderHost} className="agnes-settings-subpage-header" hidden={!top} />
        <div className="agnes-settings-subpage-main" hidden={!!top}>
          {children}
        </div>
        {stack.map((id) => (
          <div
            key={id}
            ref={hostRef(id)}
            className="agnes-settings-subpage-body agnes-settings-page-body"
            data-testid={`settings-subpage-${id}`}
            hidden={id !== top}
          />
        ))}
      </div>
    </SubpageContext.Provider>
  )
}

/** The subpages open in the nearest frame, outermost first. */
export function useSettingsSubpages(): { stack: readonly string[]; open(id: string): void; back(): void } {
  const frame = useContext(SubpageContext)
  return frame ?? { stack: [], open: () => {}, back: () => {} }
}

/** The inside of a row: optional icon tile, name with an optional hint and ⓘ, then value and control. */
function RowCopy({
  label,
  hint,
  info,
  icon,
  leading,
}: {
  label: ReactNode
  hint?: ReactNode
  info?: string | undefined
  icon?: IconName | undefined
  leading?: ReactNode
}) {
  return (
    <>
      {leading}
      {icon && <IconTile name={icon} />}
      <span className="agnes-settings-item-copy">
        <span className="agnes-settings-item-label">
          {label}
          {info && <SettingsInfo text={info} />}
        </span>
        {hint && <span className="agnes-settings-item-description">{hint}</span>}
      </span>
    </>
  )
}

/** The explanation a row no longer prints: an ⓘ beside the name, read on hover or focus. */
export function SettingsInfo({ text }: { text: string }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the explanation by focus.
    <span className="agnes-settings-info" tabIndex={0} title={text} aria-label={text} role="note">
      <Icon name="info" />
    </span>
  )
}

/**
 * A row that opens a subpage: its name, a short hint, the current value and ›. The subpage's title,
 * one-line description and actions take the header while it is open; `children` is its body. The
 * row's element is the deep-link target `settings-subsection-<id>`: revealing it opens the subpage.
 */
export function SettingsDrill({
  id,
  label,
  hint,
  info,
  icon,
  leading,
  value,
  title,
  description,
  actions,
  disabled,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLButtonElement>, 'title' | 'id'> &
  DataAttributes & {
    id: string
    label: ReactNode
    hint?: ReactNode
    info?: string | undefined
    icon?: IconName | undefined
    leading?: ReactNode
    value?: ReactNode
    /** The subpage title; the row's name when absent. */
    title?: ReactNode
    description?: ReactNode
    actions?: ReactNode
    disabled?: boolean | undefined
    children?: ReactNode
  }) {
  const frame = useContext(SubpageContext)
  const isOpen = !!frame?.stack.includes(id)
  const isTop = frame?.stack.at(-1) === id
  const body = frame?.host(id)
  return (
    <>
      <button
        type="button"
        {...props}
        id={`settings-subsection-${id}`}
        data-settings-drill={id}
        data-testid={props['data-testid'] ?? `settings-drill-${id}`}
        className={['agnes-settings-item', 'agnes-settings-drill', props.className].filter(Boolean).join(' ')}
        aria-haspopup="true"
        aria-expanded={isOpen}
        disabled={disabled}
        onClick={(event) => {
          props.onClick?.(event)
          if (!event.defaultPrevented) frame?.open(id)
        }}
      >
        <RowCopy label={label} hint={hint} info={info} icon={icon} leading={leading} />
        {value !== undefined && value !== null && value !== false && (
          <span className="agnes-settings-value">{value}</span>
        )}
        <Icon name="chevron-right" className="agnes-settings-chevron" />
      </button>
      {isTop &&
        frame?.header &&
        createPortal(
          <SettingsSubpageHeader title={title ?? label} description={description} actions={actions} />,
          frame.header,
        )}
      {isOpen && body && createPortal(children, body)}
    </>
  )
}

function SettingsSubpageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  const { back } = useSettingsSubpages()
  const heading = useRef<HTMLHeadingElement>(null)
  // A subpage is a new screen: focus moves to its title, as it does for a page.
  useEffect(() => heading.current?.focus({ preventScroll: true }), [])
  return (
    <header
      className="config-heading agnes-settings-page-heading agnes-settings-page-top"
      data-testid="settings-subpage-header"
    >
      <div>
        <button
          type="button"
          className="agnes-settings-back"
          data-testid="settings-subpage-back"
          onClick={back}
        >
          <Icon name="chevron-left" />
          {fallbackT('ui.back')}
        </button>
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="agnes-settings-actions">{actions}</div>}
    </header>
  )
}

/**
 * A row that opens in place: the details sit beneath it, inside the same group, until it is
 * clicked again. Used for one error's details or one runtime record.
 */
export function SettingsExpand({
  label,
  hint,
  info,
  icon,
  leading,
  value,
  defaultOpen = false,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> &
  DataAttributes & {
    label: ReactNode
    hint?: ReactNode
    info?: string | undefined
    icon?: IconName | undefined
    leading?: ReactNode
    value?: ReactNode
    defaultOpen?: boolean
    children?: ReactNode
  }) {
  const [open, setOpen] = useState(defaultOpen)
  const testId = props['data-testid']
  return (
    <div {...props} className={['agnes-settings-expand', props.className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="agnes-settings-item agnes-settings-drill"
        aria-expanded={open}
        data-testid={testId ? `${testId}-toggle` : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <RowCopy label={label} hint={hint} info={info} icon={icon} leading={leading} />
        {value !== undefined && value !== null && value !== false && (
          <span className="agnes-settings-value">{value}</span>
        )}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} className="agnes-settings-chevron" />
      </button>
      {open && <div className="agnes-settings-expand-body">{children}</div>}
    </div>
  )
}
