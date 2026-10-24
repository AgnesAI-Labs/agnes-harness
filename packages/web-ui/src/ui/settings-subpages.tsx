import type { HTMLAttributes, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon } from './icon.js'
import type { IconName } from './icon-set.js'
import { IconTile } from './icon-tile.js'
import { PushHeader, searchParamRoute, usePushNavigation } from './push-stack.js'
import { Tooltip } from './tooltip.js'

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

/** Dispatched (bubbling) from inside a subpage that finished, to close it at once. */
export const SUBPAGE_CLOSE_EVENT = 'agnes:settings-subpage-close'
/** A settings owner wrote a URL without a browser history traversal. */
export const SETTINGS_ROUTE_EVENT = 'agnes:settings-location'

/** The history entry a subpage adds; browser back pops to the depth it names. */
const HISTORY_KEY = 'agnesSettingsSubpage'

type SubpageFrame = {
  /** Open subpages, outermost first. */
  stack: readonly string[]
  open(id: string): void
  back(): void
  backTo(depth: number): void
  /** The page's own title: the breadcrumb's first level. */
  rootTitle: ReactNode
  title(id: string): ReactNode
  setTitle(id: string, title: ReactNode): void
  /** Where an open subpage puts its header and its body. */
  header: HTMLElement | null
  host(id: string): HTMLElement | null
}
const SubpageContext = createContext<SubpageFrame | undefined>(undefined)

/**
 * A settings page that can drill into subpages: `header` is the page's own header, shown while no
 * subpage is open. A subpage replaces the header and the body in the same dialog; its header line is
 * the breadcrumb (「General › Memory files」), whose levels and the browser's back button return. The page body stays mounted, so its state
 * survives. The stack is the shared push navigation (`usePushNavigation`) every page uses.
 */
export function SettingsSubpageFrame({
  header,
  rootTitle,
  routeId,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> &
  DataAttributes & { header: ReactNode; rootTitle?: ReactNode; routeId?: string | undefined }) {
  const route = useMemo(() => {
    if (!routeId) return undefined
    const address = searchParamRoute('settings')
    return {
      read: () => {
        const levels = address.read()
        return levels[0] === routeId ? levels.slice(1) : []
      },
      href: (stack: readonly string[]) => address.href([routeId, ...stack]),
    }
  }, [routeId])
  const nav = usePushNavigation({ historyKey: HISTORY_KEY, route, locationEvent: SETTINGS_ROUTE_EVENT })
  const { stack, reset, finish } = nav
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null)
  const [hosts, setHosts] = useState<Readonly<Record<string, HTMLElement>>>({})
  const [titles, setTitles] = useState<Readonly<Record<string, ReactNode>>>({})
  const root = useRef<HTMLDivElement>(null)
  // Closing the dialog leaves its subpages: it opens again on the page itself.
  useEffect(() => {
    const dialog = root.current?.closest('dialog')
    if (!dialog) return
    dialog.addEventListener('close', reset)
    return () => dialog.removeEventListener('close', reset)
  }, [reset])
  // A subpage that finished by itself (a saved form) closes at once.
  useEffect(() => {
    const node = root.current
    if (!node) return
    const close = (event: Event) => {
      event.stopPropagation()
      finish()
    }
    node.addEventListener(SUBPAGE_CLOSE_EVENT, close)
    return () => node.removeEventListener(SUBPAGE_CLOSE_EVENT, close)
  }, [finish])
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
  const setTitle = useCallback(
    (id: string, title: ReactNode) =>
      setTitles((known) => (known[id] === title ? known : { ...known, [id]: title })),
    [],
  )
  const frame = useMemo<SubpageFrame>(
    () => ({
      stack,
      open: nav.open,
      back: nav.back,
      backTo: nav.backTo,
      rootTitle,
      title: (id) => titles[id] ?? id,
      setTitle,
      header: headerHost,
      host: (id) => hosts[id] ?? null,
    }),
    [stack, nav.open, nav.back, nav.backTo, rootTitle, titles, setTitle, headerHost, hosts],
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
export function useSettingsSubpages(): {
  stack: readonly string[]
  open(id: string): void
  back(): void
  /** Whether a settings page with subpages encloses this component. */
  available: boolean
} {
  const frame = useContext(SubpageContext)
  return frame
    ? { stack: frame.stack, open: frame.open, back: frame.back, available: true }
    : { stack: [], open: () => {}, back: () => {}, available: false }
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
    <Tooltip title={text}>
      <span
        className="agnes-settings-info agh-touch-target"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the explanation by focus.
        tabIndex={0}
        aria-label={text}
        role="note"
      >
        <Icon name="info" />
      </span>
    </Tooltip>
  )
}

/**
 * A row that opens a subpage: its name, a short hint, the current value and ›. The subpage's title
 * (the breadcrumb's last level) and actions take the header line while it is open, the description
 * is read to assistive tech only; `children` is its body. The
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
  const pageTitle = title ?? label
  const setTitle = frame?.setTitle
  useEffect(() => setTitle?.(id, pageTitle), [setTitle, id, pageTitle])
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
          <SettingsSubpageHeader id={id} title={pageTitle} description={description} actions={actions} />,
          frame.header,
        )}
      {isOpen && body && createPortal(children, body)}
    </>
  )
}

function SettingsSubpageHeader({
  id,
  title,
  description,
  actions,
}: {
  id: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  const frame = useContext(SubpageContext)
  if (!frame) return null
  const depth = frame.stack.indexOf(id)
  const crumbs = [
    ...(frame.rootTitle === undefined ? [] : [frame.rootTitle]),
    ...frame.stack.slice(0, depth).map((level) => frame.title(level)),
  ]
  // Without a root title the crumbs start at the first subpage, one level shorter.
  const offset = frame.rootTitle === undefined ? 1 : 0
  return (
    <PushHeader
      line
      className="config-heading agnes-settings-page-heading agnes-settings-page-top"
      title={title}
      crumbs={crumbs}
      description={description}
      actions={actions}
      onBack={frame.back}
      onCrumb={(level) => frame.backTo(level + offset)}
      testIds={{ header: 'settings-subpage-header', back: 'settings-subpage-back' }}
    />
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
  open: controlledOpen,
  onOpenChange,
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
    /** Controlled expansion; omit to let the row keep its own state. */
    open?: boolean
    onOpenChange?(open: boolean): void
    children?: ReactNode
  }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const testId = props['data-testid']
  const toggle = () => {
    const next = !open
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  return (
    <div {...props} className={['agnes-settings-expand', props.className].filter(Boolean).join(' ')}>
      <button
        type="button"
        className="agnes-settings-item agnes-settings-drill"
        aria-expanded={open}
        data-testid={testId ? `${testId}-toggle` : undefined}
        onClick={toggle}
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
