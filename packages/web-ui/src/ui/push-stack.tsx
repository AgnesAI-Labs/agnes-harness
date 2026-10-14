import type { HTMLAttributes, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fallbackT } from '../locales/index.js'
import { Icon } from './icon.js'

/**
 * One way to go deeper: a page opens in place of the current one (push). Its header has 「‹ 返回」
 * and a breadcrumb (上一级 › 当前); the browser's back button returns one level; with a route, the
 * address names the open page so it can be linked to directly.
 */

/** Where the open pages live in the address, so a page can be linked to and reloaded. */
export type PushRoute = {
  /** The pages the current address opens, outermost first. */
  read(): string[]
  /** The address for these open pages. */
  href(stack: readonly string[]): string
}

/** A route kept in one search parameter, levels joined by `/` (`?view=agent:fde-crm/edit`). */
export function searchParamRoute(param: string): PushRoute {
  return {
    read() {
      // Split the raw value: a level may hold an encoded `/` (a package id), decoded only after.
      const name = encodeURIComponent(param).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const raw = new RegExp(`[?&]${name}=([^&#]*)`).exec(location.search)?.[1]
      if (!raw) return []
      return raw
        .split('/')
        .filter(Boolean)
        .map((level) => {
          try {
            return decodeURIComponent(level.replace(/\+/g, ' '))
          } catch {
            return level
          }
        })
    },
    href(stack) {
      const url = new URL(location.href)
      if (!stack.length) {
        url.searchParams.delete(param)
        return `${url.pathname}${url.search}${url.hash}`
      }
      // Levels stay readable in the address (`view=crm/edit`); each level is encoded on its own.
      const marker = '\u0000levels\u0000'
      url.searchParams.set(param, marker)
      const search = url.search.replace(encodeURIComponent(marker), stack.map(encodeURIComponent).join('/'))
      return `${url.pathname}${search}${url.hash}`
    },
  }
}

export type PushNavigation = {
  /** Open pages, outermost first. */
  stack: readonly string[]
  open(id: string): void
  /**
   * Swap the top page for another without a new history entry: a flow that moves on (添加插件 →
   * 审阅 → 插件详情), so back leaves the flow instead of landing on a finished step.
   */
  replace(id: string): void
  /** Return one level; through the browser's history when this frame put the level there. */
  back(): void
  /** Return to this depth (0 is the root page). */
  backTo(depth: number): void
  /**
   * Close the top page because it finished (a saved form), at once: its history entry is
   * relabelled rather than gone back over, so a page opened right after is not closed by a late
   * popstate. The entry it leaves behind is one extra back step.
   */
  finish(): void
  /** Close every page without touching history (the host closed). */
  reset(): void
}

function historyDepth(state: unknown, key: string): number {
  const depth = (state as Record<string, unknown> | null)?.[key]
  return typeof depth === 'number' ? depth : 0
}

/**
 * The stack behind every push frame. Each opened level adds one history entry under `historyKey`,
 * so browser back pops exactly one level; with a `route` the address follows the stack.
 */
export function usePushNavigation({
  historyKey,
  route,
  locationEvent,
}: {
  historyKey: string
  route?: PushRoute | undefined
  /** A host committed a route without traversing browser history. */
  locationEvent?: string | undefined
}): PushNavigation {
  const [stack, setStack] = useState<readonly string[]>(() => route?.read() ?? [])
  const current = useRef(stack)
  // Levels below `base` came from the address (a link or a reload) and have no history entry.
  const base = useRef(stack.length)
  const routeRef = useRef(route)
  routeRef.current = route
  const publish = useCallback((next: readonly string[]) => {
    current.current = next
    setStack(next)
  }, [])
  useEffect(() => {
    const listener = (event: Event) => {
      const known = current.current
      if (routeRef.current) {
        // The address is the truth: a back step lands on what it names.
        const named = routeRef.current.read()
        if (named.join('/') !== known.join('/')) publish(named)
      } else {
        const depth = historyDepth((event as PopStateEvent).state, historyKey)
        if (depth < known.length) publish(known.slice(0, depth))
      }
      base.current = Math.min(base.current, current.current.length)
    }
    window.addEventListener('popstate', listener)
    if (locationEvent) window.addEventListener(locationEvent, listener)
    return () => {
      window.removeEventListener('popstate', listener)
      if (locationEvent) window.removeEventListener(locationEvent, listener)
    }
  }, [historyKey, publish, locationEvent])
  const open = useCallback(
    (id: string) => {
      const known = current.current
      if (known.at(-1) === id) return
      const next = [...known.filter((entry) => entry !== id), id]
      publish(next)
      // One history entry per level, so the browser's back button leaves the page.
      try {
        history.pushState(
          { ...(history.state ?? {}), [historyKey]: next.length },
          '',
          routeRef.current?.href(next),
        )
      } catch {}
    },
    [historyKey, publish],
  )
  const replace = useCallback(
    (id: string) => {
      const known = current.current
      if (!known.length) {
        open(id)
        return
      }
      if (known.at(-1) === id) return
      const next = [...known.slice(0, -1).filter((entry) => entry !== id), id]
      publish(next)
      try {
        history.replaceState(
          { ...(history.state ?? {}), [historyKey]: next.length },
          '',
          routeRef.current?.href(next),
        )
      } catch {}
    },
    [historyKey, open, publish],
  )
  const backTo = useCallback(
    (depth: number) => {
      const known = current.current
      const target = Math.max(0, Math.min(depth, known.length))
      if (target === known.length) return
      // Levels this frame pushed go back through history, so back and forward stay truthful.
      if (target >= base.current && historyDepth(history.state, historyKey) === known.length) {
        if (known.length - target === 1) history.back()
        else history.go(target - known.length)
        return
      }
      const next = known.slice(0, target)
      base.current = Math.min(base.current, target)
      publish(next)
      const address = routeRef.current
      if (address)
        try {
          history.replaceState({ ...(history.state ?? {}), [historyKey]: target }, '', address.href(next))
        } catch {}
    },
    [historyKey, publish],
  )
  const back = useCallback(() => backTo(current.current.length - 1), [backTo])
  const finish = useCallback(() => {
    const known = current.current
    if (!known.length) return
    const next = known.slice(0, -1)
    if (historyDepth(history.state, historyKey) === known.length)
      try {
        history.replaceState(
          { ...(history.state ?? {}), [historyKey]: next.length },
          '',
          routeRef.current?.href(next),
        )
      } catch {}
    base.current = Math.min(base.current, next.length)
    publish(next)
  }, [historyKey, publish])
  const reset = useCallback(() => {
    base.current = 0
    publish([])
  }, [publish])
  return useMemo(
    () => ({ stack, open, replace, back, backTo, finish, reset }),
    [stack, open, replace, back, backTo, finish, reset],
  )
}

/**
 * The header of an open page: the breadcrumb is the way back, with no separate 返回 beside it. It
 * starts with 「‹」 (「‹ 模型与账户 › 添加账户」); the level just above this page is the back control
 * (named 「返回到 …」, it goes back one step through history), and every earlier level jumps to its
 * own page. Then the title, an optional line under it and the page's actions. Focus moves to the
 * title when the page opens, as it does for a new page.
 */
export function PushHeader({
  title,
  crumbs,
  description,
  actions,
  onBack,
  onCrumb,
  className,
  testIds = {},
}: {
  title: ReactNode
  /** Titles of the levels above, the root first. */
  crumbs: readonly ReactNode[]
  description?: ReactNode
  actions?: ReactNode
  onBack(): void
  onCrumb(depth: number): void
  className?: string
  /** `back` names the control that returns one level (`push-back` by default). */
  testIds?: { header?: string; back?: string }
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus({ preventScroll: true }), [])
  const backId = testIds.back ?? 'push-back'
  return (
    <header
      className={['agh-push-header', className].filter(Boolean).join(' ')}
      data-testid={testIds.header ?? 'push-header'}
    >
      <div className="agh-push-heading">
        <PushCrumbs title={title} crumbs={crumbs} onBack={onBack} onCrumb={onCrumb} backTestId={backId} />
        <h2 ref={heading} tabIndex={-1}>
          {title}
        </h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="agh-push-actions">{actions}</div>}
    </header>
  )
}

/**
 * The way back as a breadcrumb: 「‹ 上一级 › 当前」. ‹ leads the first level; the level just above is the
 * back control (「返回到 …」); every earlier level jumps to itself. A view with no shared page header
 * (a detail inside a list, a filtered list) uses this alone.
 */
export function PushCrumbs({
  title,
  crumbs,
  onBack,
  onCrumb,
  backTestId = 'push-back',
  backId,
  disabled,
}: {
  title: ReactNode
  /** Titles of the levels above, the outermost first. */
  crumbs: readonly ReactNode[]
  onBack(): void
  /** Jump to an earlier level (its index in `crumbs`); without it earlier levels go back too. */
  onCrumb?(depth: number): void
  backTestId?: string
  /** An element id for the back control, for hosts that bind to it. */
  backId?: string
  disabled?: boolean
}) {
  const parent = crumbs.length - 1
  return (
    <nav className="agh-push-crumbs" aria-label={fallbackT('ui.breadcrumb')}>
      <ol>
        {crumbs.length === 0 ? (
          // A view with no named level above it still has its way back.
          <li>
            <button
              type="button"
              className="agh-push-crumb agh-push-back"
              id={backId}
              data-testid={backTestId}
              disabled={disabled}
              onClick={onBack}
            >
              <Icon name="chevron-left" className="agh-push-crumb-lead" />
              {fallbackT('ui.back')}
            </button>
          </li>
        ) : (
          crumbs.map((crumb, depth) => (
            // The crumbs are fixed for one open view; the depth is their identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: levels never reorder.
            <li key={depth}>
              <button
                type="button"
                className={['agh-push-crumb', depth === parent && 'agh-push-back'].filter(Boolean).join(' ')}
                data-testid={depth === parent ? backTestId : `push-crumb-${depth}`}
                id={depth === parent ? backId : undefined}
                disabled={disabled}
                {...(depth === parent && typeof crumb === 'string'
                  ? { 'aria-label': fallbackT('ui.backTo', { name: crumb }) }
                  : {})}
                onClick={() => (depth === parent || !onCrumb ? onBack() : onCrumb(depth))}
              >
                {depth === 0 && <Icon name="chevron-left" className="agh-push-crumb-lead" />}
                {depth === parent && typeof crumb !== 'string' && (
                  <span className="agh-visually-hidden">{fallbackT('ui.backToPrefix')}</span>
                )}
                {crumb}
              </button>
              <Icon name="chevron-right" className="agh-push-crumb-separator" />
            </li>
          ))
        )}
        {crumbs.length > 0 && (
          <li aria-current="page" className="agh-push-crumb-current">
            {title}
          </li>
        )}
      </ol>
    </nav>
  )
}

type PushFrame = PushNavigation & {
  rootTitle: ReactNode
  title(id: string): ReactNode
  setTitle(id: string, title: ReactNode): void
  header: HTMLElement | null
  host(id: string): HTMLElement | null
}
const PushContext = createContext<PushFrame | undefined>(undefined)

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

/**
 * A region that pages push into: a full page (Agent FDE, 插件, 自动化) or a pane. The root content
 * stays mounted under open pages, so its state (scroll, filters) survives a round trip.
 */
export function PushStack({
  rootTitle,
  historyKey = 'agnesPushPage',
  route,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> &
  DataAttributes & {
    /** The root page's title: the breadcrumb's first level. */
    rootTitle: ReactNode
    /** History state key; frames that can be open at once need their own. */
    historyKey?: string
    route?: PushRoute
  }) {
  const nav = usePushNavigation({ historyKey, route })
  const [titles, setTitles] = useState<Readonly<Record<string, ReactNode>>>({})
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null)
  const [hosts, setHosts] = useState<Readonly<Record<string, HTMLElement>>>({})
  const hostRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const hostRef = (id: string) => {
    let ref = hostRefs.current.get(id)
    if (!ref) {
      ref = (node) =>
        setHosts((known) => {
          if (node ? known[id] === node : !known[id]) return known
          const next = { ...known }
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
  const frame = useMemo<PushFrame>(
    () => ({
      ...nav,
      rootTitle,
      title: (id) => titles[id] ?? id,
      setTitle,
      header: headerHost,
      host: (id) => hosts[id] ?? null,
    }),
    [nav, rootTitle, titles, setTitle, headerHost, hosts],
  )
  const top = nav.stack.at(-1)
  return (
    <PushContext.Provider value={frame}>
      <div
        {...props}
        className={['agh-push-stack', props.className].filter(Boolean).join(' ')}
        data-push-page={top}
      >
        <div className="agh-push-root" hidden={!!top}>
          {children}
        </div>
        <div ref={setHeaderHost} className="agh-push-header-host" hidden={!top} />
        {nav.stack.map((id) => (
          <div
            key={id}
            ref={hostRef(id)}
            className="agh-push-body"
            data-testid={`push-page-${id}`}
            hidden={id !== top}
          />
        ))}
      </div>
    </PushContext.Provider>
  )
}

const noop = () => {}
/** The nearest push frame; outside one, opening does nothing. */
export function usePushStack(): PushNavigation {
  const frame = useContext(PushContext)
  return (
    frame ?? { stack: [], open: noop, replace: noop, back: noop, backTo: noop, finish: noop, reset: noop }
  )
}

/**
 * One page of a push frame. Declare it where its data lives; it renders only while open, into the
 * frame. `id` is the route segment, so a link or a reload opens it directly.
 */
export function PushPage({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  const frame = useContext(PushContext)
  const setTitle = frame?.setTitle
  useEffect(() => setTitle?.(id, title), [setTitle, id, title])
  if (!frame) return null
  const depth = frame.stack.indexOf(id)
  if (depth < 0) return null
  const body = frame.host(id)
  const isTop = depth === frame.stack.length - 1
  const crumbs = [frame.rootTitle, ...frame.stack.slice(0, depth).map((level) => frame.title(level))]
  return (
    <>
      {isTop &&
        frame.header &&
        createPortal(
          <PushHeader
            key={id}
            title={title}
            crumbs={crumbs}
            description={description}
            actions={actions}
            onBack={frame.back}
            onCrumb={frame.backTo}
          />,
          frame.header,
        )}
      {body && createPortal(children, body)}
    </>
  )
}
