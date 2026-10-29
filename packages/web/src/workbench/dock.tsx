import { type UiExtensionContext, workbenchNavigation, workbenchPanels } from '@agnes/web-client'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import {
  Button,
  createRegionRenderer,
  EmptyState,
  fileMentionLinks,
  Icon,
  IconButton,
  type IconName,
  icons,
  Menu,
  RegionErrorBoundary,
  type RegionRenderer,
  Tabs,
  Tooltip,
} from '@agnes/web-ui'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useApplicationPanelFocus, useApplicationPanels } from './application-panels.js'
import {
  BOTTOM_DEFAULT,
  BOTTOM_MIN,
  clampBottomHeight,
  clampRightWidth,
  maxBottomHeight,
  maxRightWidth,
  RIGHT_DEFAULT,
  RIGHT_MIN,
} from './dock-size.js'
import { mentionPanelPath } from './mention-path.js'
import { useTabOverflow } from './tab-fit.js'

type Layout = { rightOpen: boolean; bottomOpen: boolean; rightWidth: number; bottomHeight: number }
const sharedIcon = (name: string | undefined): name is IconName => !!name && Object.hasOwn(icons, name)
const edges = ['right', 'bottom'] as const
const key = 'agnes.workbench.layout.v1'
const defaults: Layout = {
  rightOpen: false,
  bottomOpen: false,
  rightWidth: RIGHT_DEFAULT,
  bottomHeight: BOTTOM_DEFAULT,
}
function readLayout(sessionId: string | undefined): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Layout> & { sessionId?: string }
    const sameSession = !!sessionId && value.sessionId === sessionId
    return {
      rightOpen: sameSession && value.rightOpen === true,
      bottomOpen: sameSession && value.bottomOpen === true,
      // The stored width is what the reader chose; the window decides how much of it fits.
      rightWidth: Number.isFinite(value.rightWidth)
        ? Math.max(RIGHT_MIN, value.rightWidth ?? RIGHT_DEFAULT)
        : RIGHT_DEFAULT,
      bottomHeight: Number.isFinite(value.bottomHeight)
        ? Math.max(BOTTOM_MIN, Math.min(450, value.bottomHeight ?? BOTTOM_DEFAULT))
        : BOTTOM_DEFAULT,
    }
  } catch {
    return defaults
  }
}
type DockTab = { id: string; title: string; icon: IconName | undefined; count?: number | undefined }
/**
 * A dock's tab strip. Tabs that do not fit the strip fold into one "more" menu instead of scrolling
 * out of sight; the current tab always stays in the strip.
 */
function DockTabs({
  edge,
  label,
  more,
  tabs,
  activeId,
  select,
  open,
}: {
  edge: 'right' | 'bottom'
  label: string
  more: string
  tabs: readonly DockTab[]
  activeId: string | undefined
  select(id: string): void
  open(id: string): void
}) {
  // More than five panels never share the strip, however wide it is: four stay, and the fifth
  // place goes to the current tab when it is one of the rest.
  const crowded = tabs.length > 5
  const activeIndex = tabs.findIndex((tab) => tab.id === activeId)
  const strip = crowded
    ? [...tabs.slice(0, 4), ...tabs.slice(Math.max(4, activeIndex), Math.max(4, activeIndex) + 1)]
    : tabs
  const overflow = useTabOverflow(
    strip.map((tab) => tab.id),
    activeId,
    JSON.stringify(strip),
  )
  const folded = tabs.filter((tab, index) => (crowded && index >= 4) || overflow.hidden.includes(tab.id))
  return (
    <>
      <Tabs
        className="workbench-dock-tabs"
        {...(activeId ? { activeKey: activeId } : {})}
        items={tabs.map((tab) => ({ key: tab.id, label: tab.title }))}
        renderTabBar={() => (
          <div ref={overflow.strip} role="tablist" aria-label={label} className="workbench-panel-tabs">
            {strip.map((tab) => (
              <Button
                type="text"
                size="small"
                key={tab.id}
                role="tab"
                id={`workbench-tab-${tab.id}`}
                data-testid={`workbench-tab-${tab.id}`}
                data-overflow={overflow.hidden.includes(tab.id) ? 'true' : undefined}
                aria-selected={activeId === tab.id}
                aria-controls={`workbench-panel-${edge}`}
                tabIndex={activeId === tab.id ? 0 : -1}
                onClick={() => select(tab.id)}
                onKeyDown={(event) => {
                  const index = tabs.indexOf(tab)
                  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                  if (!step && event.key !== 'Home' && event.key !== 'End') return
                  event.preventDefault()
                  const next =
                    tabs[
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : (index + step + tabs.length) % tabs.length
                    ]
                  if (next) {
                    flushSync(() => select(next.id))
                    document.getElementById(`workbench-tab-${next.id}`)?.focus()
                  }
                }}
              >
                {tab.icon && <Icon name={tab.icon} />}
                {tab.title}
                {!!tab.count && (
                  <span className="workbench-tab-count" data-testid={`workbench-tab-count-${tab.id}`}>
                    {tab.count}
                  </span>
                )}
              </Button>
            ))}
          </div>
        )}
      />
      {folded.length > 0 && (
        <Menu
          label={more}
          trigger={<IconButton name="ellipsis" label={more} />}
          items={folded.map((tab) => ({ id: tab.id, label: tab.title, onSelect: () => open(tab.id) }))}
        />
      )}
    </>
  )
}
export function Dock({ context }: { context: UiExtensionContext }) {
  const registryVersion = useSyncExternalStore(workbenchPanels.subscribe, workbenchPanels.getSnapshot)
  const applicationPanels = useApplicationPanels(context)
  const panels = useMemo(() => {
    void registryVersion
    return [...workbenchPanels.entries(), ...applicationPanels].sort((a, b) => a.order - b.order)
  }, [registryVersion, applicationPanels])
  const getPanel = useCallback((id: string) => panels.find((panel) => panel.id === id), [panels])
  // A tab count changes without the dock's context changing (a poll, a session client update).
  const [, setCountVersion] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a registry change brings new count sources.
  useEffect(() => {
    const stops = workbenchPanels
      .entries()
      .flatMap((panel) => (panel.count ? [panel.count.subscribe(() => setCountVersion((v) => v + 1))] : []))
    return () => {
      for (const stop of stops) stop()
    }
  }, [registryVersion])
  const bottomAvailable = workbenchPanels
    .entries()
    .some((panel) => panel.edge === 'bottom' && (panel.visibility !== 'contextual' || panel.when?.(context)))
  const sessionId = (context.data as WorkbenchContext)?.session?.id
  const [layout, setLayout] = useState(() => readLayout(sessionId))
  const [expanded, setExpanded] = useState(false)
  const [rightMax, setRightMax] = useState(() => maxRightWidth(window.innerWidth))
  const rightWidth = clampRightWidth(layout.rightWidth, rightMax)
  useEffect(() => {
    if (!bottomAvailable) setLayout((value) => (value.bottomOpen ? { ...value, bottomOpen: false } : value))
  }, [bottomAvailable])
  const returnFocus = useRef<Partial<Record<'right' | 'bottom', HTMLElement>>>({})
  const [selection, setSelection] = useState<unknown>()
  const [selected, setSelected] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('agnes.workbench.selection.v1') ?? '{}')
      return {
        right: typeof saved.right === 'string' ? saved.right : 'files',
        bottom: typeof saved.bottom === 'string' ? saved.bottom : 'terminal',
      }
    } catch {
      return { right: 'files', bottom: 'terminal' }
    }
  })
  const surfaces = useMemo(
    () => ({
      split: document.querySelector<HTMLElement>('.workbench-split'),
      right: document.getElementById('workbench-right'),
      bottom: document.getElementById('workbench-bottom'),
      rightContent: document.getElementById('workbench-right-content'),
      bottomContent: document.getElementById('workbench-bottom-content'),
    }),
    [],
  )
  // The limit follows the main column: the window, and the sidebar opening or closing beside it.
  useEffect(() => {
    const main = surfaces.split?.closest('main')
    const update = () => {
      const width = main?.getBoundingClientRect().width
      setRightMax(maxRightWidth(width && width > 0 ? width : window.innerWidth))
    }
    update()
    window.addEventListener('resize', update)
    const observer = main && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined
    if (main) observer?.observe(main)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [surfaces])
  const controls = useRef<HTMLDivElement>(null)
  const { t } = context
  const workbench = context.data as WorkbenchContext
  const rememberFocus = useCallback(
    (edge: 'right' | 'bottom') => {
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement &&
        !surfaces[edge]?.contains(active)
      )
        returnFocus.current[edge] = active
    },
    [surfaces],
  )
  const restoreFocus = useCallback((edge: 'right' | 'bottom') => {
    const target = returnFocus.current[edge]
    if (target?.isConnected && target.getClientRects().length && !target.closest('[hidden], [inert]'))
      target.focus()
    else controls.current?.querySelector<HTMLButtonElement>(`[data-edge="${edge}"]`)?.focus()
  }, [])
  useEffect(() => {
    const sheet = window.matchMedia('(max-width: 767px)')
    const reconcile = () => {
      if (!sheet.matches) return
      setLayout((value) => {
        if (!value.rightOpen || !value.bottomOpen) return value
        return surfaces.bottom?.contains(document.activeElement)
          ? { ...value, rightOpen: false }
          : { ...value, bottomOpen: false }
      })
    }
    reconcile()
    sheet.addEventListener('change', reconcile)
    return () => sheet.removeEventListener('change', reconcile)
  }, [surfaces])
  useEffect(() => {
    const openPanel = (id: string, selection?: unknown) => {
      const panel = getPanel(id)
      if (!panel || (panel.visibility === 'contextual' && !panel.when?.(context))) return false
      rememberFocus(panel.edge)
      // A link may name the tab to show, such as a child agent's job in the terminal panel.
      setSelection(selection)
      setSelected((value) => ({ ...value, [panel.edge]: id }))
      setLayout((value) => ({
        ...value,
        [`${panel.edge}Open`]: true,
        ...(window.innerWidth <= 767
          ? { [`${panel.edge === 'right' ? 'bottom' : 'right'}Open`]: false }
          : {}),
      }))
      requestAnimationFrame(() => document.getElementById(`workbench-tab-${id}`)?.focus())
      return true
    }
    const removePanel = workbenchNavigation.register(openPanel)
    // A file chip in the conversation opens its file (or folder) in the files panel. A path inside
    // the workspace opens by its relative path; any other path goes as is, and the panel applies its
    // usual visibility rules to it.
    const removeMentions = fileMentionLinks.register((mention) => {
      const path = mentionPanelPath((context.data as WorkbenchContext)?.workspace?.path, mention.path)
      if (!openPanel('files')) return false
      setSelection({ path, directory: mention.directory })
      return true
    })
    return () => {
      removePanel()
      removeMentions()
    }
  }, [rememberFocus, context, getPanel])
  useEffect(
    () => () => {
      surfaces.split?.classList.remove('workbench-right-open', 'workbench-bottom-open')
      for (const edge of edges) if (surfaces[edge]) surfaces[edge].hidden = true
    },
    [surfaces],
  )
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ ...layout, sessionId }))
      localStorage.setItem('agnes.workbench.selection.v1', JSON.stringify(selected))
    } catch {
      /* in-memory layout remains usable */
    }
    const split = surfaces.split
    if (!split) return
    split.classList.toggle('workbench-right-open', layout.rightOpen)
    split.classList.toggle('workbench-bottom-open', layout.bottomOpen && bottomAvailable)
    split.style.setProperty('--workbench-width', expanded ? '60vw' : `${rightWidth}px`)
    split.parentElement?.style.setProperty('--workbench-width', expanded ? '60vw' : `${rightWidth}px`)
    split.style.setProperty('--workbench-height', `${layout.bottomHeight}px`)
    for (const edge of edges) {
      const host = surfaces[edge]
      if (host) host.hidden = !layout[`${edge}Open`] || (edge === 'bottom' && !bottomAvailable)
    }
  }, [layout, rightWidth, surfaces, expanded, selected, bottomAvailable, sessionId])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const edge = edges.find(
        (value) => layout[`${value}Open`] && surfaces[value]?.contains(event.target as Node),
      )
      if (!edge || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        setLayout((value) => ({ ...value, [`${edge}Open`]: false }))
        restoreFocus(edge)
      }
      if (event.key === 'Tab' && (edge === 'right' ? window.innerWidth < 1280 : window.innerWidth <= 767)) {
        const nodes = [
          ...(surfaces[edge]?.querySelectorAll<HTMLElement>(
            'button, input, textarea, select, summary, a[href], [tabindex]',
          ) ?? []),
        ].filter(
          (node) =>
            node.tabIndex >= 0 &&
            !node.matches(':disabled') &&
            !node.closest('[hidden], [inert]') &&
            node.getClientRects().length > 0 &&
            getComputedStyle(node).visibility !== 'hidden',
        )
        const first = nodes[0],
          last = nodes.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => document.removeEventListener('keydown', keyboard)
  }, [layout, surfaces, restoreFocus])
  const openPanel = (id: string, payload?: unknown) => {
    const panel = getPanel(id)
    if (!panel || (panel.visibility === 'contextual' && !panel.when?.(context))) return
    const edge = panel.edge
    rememberFocus(edge)
    setSelection(payload)
    setSelected((value) => ({ ...value, [edge]: id }))
    setLayout((value) => ({
      ...value,
      [`${edge}Open`]: true,
      ...(window.innerWidth <= 767 ? { [`${edge === 'right' ? 'bottom' : 'right'}Open`]: false } : {}),
    }))
    requestAnimationFrame(() =>
      surfaces[edge]?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus(),
    )
  }
  useApplicationPanelFocus(context, applicationPanels, openPanel)
  const close = (edge: 'right' | 'bottom') => {
    setLayout((value) => ({ ...value, [`${edge}Open`]: false }))
    restoreFocus(edge)
  }
  const leaveOverlay = (edge: 'right' | 'bottom') => {
    if (edge === 'right' ? window.innerWidth < 1280 : window.innerWidth <= 767)
      flushSync(() => setLayout((value) => ({ ...value, [`${edge}Open`]: false })))
  }
  const size = (edge: 'right' | 'bottom') =>
    edge === 'right'
      ? rightWidth
      : clampBottomHeight(layout.bottomHeight, maxBottomHeight(window.innerHeight))
  const resizeTo = (edge: 'right' | 'bottom', next: number) =>
    setLayout((value) => ({
      ...value,
      ...(edge === 'right'
        ? { rightWidth: clampRightWidth(next, rightMax) }
        : { bottomHeight: clampBottomHeight(next, maxBottomHeight(window.innerHeight)) }),
    }))
  const controlsView = (
    <div ref={controls} className="workbench-controls">
      {[...edges].reverse().map((edge) => {
        const entries = panels.filter(
          (panel) => panel.edge === edge && (panel.visibility !== 'contextual' || panel.when?.(context)),
        )
        if (entries.length === 0 && edge === 'bottom') return null
        const active = entries.find((panel) => panel.id === selected[edge]) ?? entries[0]
        const Component = active?.component
        const host = surfaces[`${edge}Content`]
        const open = layout[`${edge}Open`]
        return (
          <span key={edge}>
            <Tooltip title={t(`workbench.${edge}`)}>
              <Button
                type="text"
                size="small"
                className="workbench-toggle"
                data-edge={edge}
                data-testid={`workbench-${edge}-toggle`}
                aria-controls={`workbench-${edge}`}
                aria-expanded={open}
                aria-pressed={open}
                aria-label={t(`workbench.${edge}`)}
                onClick={() => {
                  rememberFocus(edge)
                  setLayout((value) => ({
                    ...value,
                    [`${edge}Open`]: !open,
                    ...(window.innerWidth <= 767
                      ? { [`${edge === 'right' ? 'bottom' : 'right'}Open`]: false }
                      : {}),
                  }))
                  if (!open)
                    requestAnimationFrame(() =>
                      host?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus(),
                    )
                }}
              >
                <span className="workbench-toggle-icon" aria-hidden="true">
                  <Icon name={edge === 'right' ? 'panel-right' : 'terminal'} size={18} />
                  {edge === 'right' && <span className="workbench-toggle-pane" />}
                </span>
              </Button>
            </Tooltip>
            {host &&
              createPortal(
                <div className="workbench-dock-body">
                  <hr
                    className="workbench-resize"
                    hidden={edge === 'right' && expanded}
                    tabIndex={0}
                    aria-label={t('workbench.resize')}
                    aria-orientation={edge === 'right' ? 'vertical' : 'horizontal'}
                    aria-valuemin={edge === 'right' ? RIGHT_MIN : BOTTOM_MIN}
                    aria-valuemax={edge === 'right' ? rightMax : maxBottomHeight(window.innerHeight)}
                    aria-valuenow={size(edge)}
                    title={t('workbench.resizeHint')}
                    onDoubleClick={() => resizeTo(edge, edge === 'right' ? RIGHT_DEFAULT : BOTTOM_DEFAULT)}
                    onKeyDown={(event) => {
                      if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
                        event.preventDefault()
                        resizeTo(edge, size(edge) + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? 16 : -16))
                      }
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      const element = event.currentTarget
                      element.setPointerCapture(event.pointerId)
                      // Measured from where the drag began, so the edge stays under the pointer
                      // after it has been pushed past a limit and comes back.
                      const origin = edge === 'right' ? event.clientX : event.clientY
                      const start = size(edge)
                      element.dataset.dragging = 'true'
                      const move = (next: PointerEvent) =>
                        resizeTo(edge, start + origin - (edge === 'right' ? next.clientX : next.clientY))
                      const end = () => {
                        delete element.dataset.dragging
                        element.removeEventListener('pointermove', move)
                        element.removeEventListener('pointerup', end)
                        element.removeEventListener('pointercancel', end)
                      }
                      element.addEventListener('pointermove', move)
                      element.addEventListener('pointerup', end)
                      element.addEventListener('pointercancel', end)
                    }}
                  />
                  <div className="workbench-dock-heading">
                    <DockTabs
                      edge={edge}
                      label={t(`workbench.${edge}`)}
                      more={t('workbench.more')}
                      tabs={entries.map((panel) => ({
                        id: panel.id,
                        title: panel.title?.(context) ?? t(panel.titleKey),
                        icon: sharedIcon(panel.icon) ? panel.icon : undefined,
                        count: panel.count?.read(context),
                      }))}
                      activeId={active?.id}
                      select={(id) => setSelected((value) => ({ ...value, [edge]: id }))}
                      open={openPanel}
                    />
                    <div id={`workbench-header-actions-${edge}`} className="workbench-header-actions" />
                    {edge === 'right' && (
                      <IconButton
                        name="maximize-2"
                        label={t(expanded ? 'workbench.collapse' : 'workbench.expand')}
                        aria-pressed={expanded}
                        onClick={() => setExpanded((value) => !value)}
                      />
                    )}
                    <IconButton name="x" label={t('workbench.close')} onClick={() => close(edge)} />
                  </div>
                  <div
                    role="tabpanel"
                    id={`workbench-panel-${edge}`}
                    aria-labelledby={active ? `workbench-tab-${active.id}` : undefined}
                    className="workbench-panel-content"
                  >
                    <RegionErrorBoundary key={active?.id} region={`workbench-${edge}`}>
                      {!Component && open && (
                        <EmptyState
                          icon={<Icon name="panel-right" />}
                          title={t(`workbench.${edge}`)}
                          description={t('workbench.session')}
                        />
                      )}
                      {Component && open && (
                        <Component
                          key={active.id}
                          context={{
                            ...context,
                            selection,
                            openPanel,
                            ...(context.openRecord
                              ? {
                                  openRecord: (sessionId, callSeq, resultSeq) => {
                                    leaveOverlay(edge)
                                    return context.openRecord?.(sessionId, callSeq, resultSeq) ?? false
                                  },
                                }
                              : {}),
                            data: {
                              ...workbench,
                              ...(workbench?.mention
                                ? {
                                    mention: (path: string, directory?: boolean) => {
                                      leaveOverlay(edge)
                                      workbench.mention(path, directory)
                                    },
                                  }
                                : {}),
                            },
                          }}
                          headerId={`workbench-header-actions-${edge}`}
                        />
                      )}
                    </RegionErrorBoundary>
                  </div>
                </div>,
                host,
              )}
          </span>
        )
      })}
    </div>
  )
  // The toggles live in the bar's action group (this region's host).
  return controlsView
}
const workbenchRenderers = new WeakMap<HTMLElement, RegionRenderer>()
const pendingUnmounts = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()
/** Controller refreshes may arrive in bursts; only this domain surface publishes once per frame. */
export function renderWorkbench(host: HTMLElement, context: UiExtensionContext): void {
  clearTimeout(pendingUnmounts.get(host))
  pendingUnmounts.delete(host)
  let renderer = workbenchRenderers.get(host)
  const initial = !renderer
  if (!renderer) {
    renderer = createRegionRenderer(host, { notify: 'animation-frame' })
    workbenchRenderers.set(host, renderer)
  }
  // A conversation change must not inherit another conversation's open panels or selection payload.
  renderer.render(<Dock key={(context.data as WorkbenchContext)?.session?.id} context={context} />)
  if (initial) renderer.flush()
}

export function unmountWorkbench(host: HTMLElement): void {
  clearTimeout(pendingUnmounts.get(host))
  pendingUnmounts.delete(host)
  workbenchRenderers.get(host)?.unmount()
  workbenchRenderers.delete(host)
}

/**
 * Unmounts in a later task: a session switch hides the dock at once, but tearing its tree down
 * synchronously would delay the requests for the next session. Rendering again cancels it.
 */
export function unmountWorkbenchSoon(host: HTMLElement): void {
  if (!workbenchRenderers.has(host) || pendingUnmounts.has(host)) return
  pendingUnmounts.set(
    host,
    setTimeout(() => {
      pendingUnmounts.delete(host)
      unmountWorkbench(host)
    }, 0),
  )
}
