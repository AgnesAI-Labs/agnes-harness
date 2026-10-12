import type { FactChainParams } from '@agnes/protocol'
import {
  factChainLinks,
  type UiExtensionContext,
  workbenchNavigation,
  workbenchPanels,
} from '@agnes/web-client'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  type IconName,
  icons,
  Menu,
  renderRegion,
  Tabs,
  Toast,
  Tooltip,
  unmountRegion,
} from '@agnes/web-ui'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal, flushSync } from 'react-dom'

type Layout = { rightOpen: boolean; bottomOpen: boolean; rightWidth: number; bottomHeight: number }
const sharedIcon = (name: string | undefined): name is IconName => !!name && Object.hasOwn(icons, name)
const edges = ['right', 'bottom'] as const
const key = 'agnes.workbench.layout.v1'
const defaults: Layout = { rightOpen: false, bottomOpen: false, rightWidth: 320, bottomHeight: 220 }
function readLayout(): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Layout>
    return {
      rightOpen: value.rightOpen === true,
      bottomOpen: value.bottomOpen === true,
      rightWidth: Number.isFinite(value.rightWidth)
        ? Math.max(240, Math.min(480, value.rightWidth ?? 320))
        : 320,
      bottomHeight: Number.isFinite(value.bottomHeight)
        ? Math.max(120, Math.min(450, value.bottomHeight ?? 220))
        : 220,
    }
  } catch {
    return defaults
  }
}
export function Dock({ context }: { context: UiExtensionContext }) {
  useSyncExternalStore(workbenchPanels.subscribe, workbenchPanels.getSnapshot)
  const bottomAvailable = workbenchPanels
    .entries()
    .some((panel) => panel.edge === 'bottom' && (panel.visibility !== 'contextual' || panel.when?.(context)))
  const [layout, setLayout] = useState(readLayout)
  const [expanded, setExpanded] = useState(false)
  const [copyMessage, setCopyMessage] = useState('')
  useEffect(() => {
    if (!bottomAvailable) setLayout((value) => (value.bottomOpen ? { ...value, bottomOpen: false } : value))
  }, [bottomAvailable])
  const [factTarget, setFactTarget] = useState<FactChainParams>()
  const returnFocus = useRef<Partial<Record<'right' | 'bottom', HTMLElement>>>({})
  const sessionId = (context.data as WorkbenchContext)?.session?.id
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
  useEffect(() => setFactTarget((value) => (value?.sessionId === sessionId ? value : undefined)), [sessionId])
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
    const openPanel = (id: string) => {
      const panel = workbenchPanels.get(id)
      if (!panel || (panel.visibility === 'contextual' && !panel.when?.(context))) return false
      rememberFocus(panel.edge)
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
    const removeFacts = factChainLinks.register((target) => {
      if (target.sessionId !== sessionId || !openPanel('facts')) return false
      setFactTarget(target)
      return true
    })
    return () => {
      removeFacts()
      removePanel()
    }
  }, [sessionId, rememberFocus, context])
  useEffect(
    () => () => {
      surfaces.split?.classList.remove('workbench-right-open', 'workbench-bottom-open')
      for (const edge of edges) if (surfaces[edge]) surfaces[edge].hidden = true
    },
    [surfaces],
  )
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(layout))
      localStorage.setItem('agnes.workbench.selection.v1', JSON.stringify(selected))
    } catch {
      /* in-memory layout remains usable */
    }
    const split = surfaces.split
    if (!split) return
    split.classList.toggle('workbench-right-open', layout.rightOpen)
    split.classList.toggle('workbench-bottom-open', layout.bottomOpen && bottomAvailable)
    split.style.setProperty('--workbench-width', expanded ? '60vw' : `${layout.rightWidth}px`)
    split.parentElement?.style.setProperty('--workbench-width', expanded ? '60vw' : `${layout.rightWidth}px`)
    split.style.setProperty('--workbench-height', `${layout.bottomHeight}px`)
    for (const edge of edges) {
      const host = surfaces[edge]
      if (host) host.hidden = !layout[`${edge}Open`] || (edge === 'bottom' && !bottomAvailable)
    }
  }, [layout, surfaces, expanded, selected, bottomAvailable])
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
    const panel = workbenchPanels.get(id)
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
  const close = (edge: 'right' | 'bottom') => {
    setLayout((value) => ({ ...value, [`${edge}Open`]: false }))
    restoreFocus(edge)
  }
  const leaveOverlay = (edge: 'right' | 'bottom') => {
    if (edge === 'right' ? window.innerWidth < 1280 : window.innerWidth <= 767)
      flushSync(() => setLayout((value) => ({ ...value, [`${edge}Open`]: false })))
  }
  const resize = (edge: 'right' | 'bottom', amount: number) =>
    setLayout((value) => ({
      ...value,
      ...(edge === 'right'
        ? { rightWidth: Math.max(240, Math.min(480, value.rightWidth + amount)) }
        : { bottomHeight: Math.max(120, Math.min(window.innerHeight / 2, value.bottomHeight + amount)) }),
    }))
  const workspaceHost = document.querySelector('.topbar')
  const workspace = workbench?.workspace
  const copyWorkspace = async () => {
    if (!workspace) return
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(workspace.path)
      setCopyMessage(t('workbench.copied'))
    } catch {
      setCopyMessage(t('workbench.copyFailed'))
    }
  }
  const controlsView = (
    <div ref={controls} className="workbench-controls">
      <Toast open={!!copyMessage} onDismiss={() => setCopyMessage('')}>
        {copyMessage}
      </Toast>
      {workspace &&
        workspaceHost &&
        createPortal(
          <Tooltip title={t('workbench.workspace')}>
            <Button
              appearance="ghost"
              size="small"
              className="topbar-workspace"
              onClick={() => void copyWorkspace()}
            >
              <Icon name="folder" />
              {workspace.name}
            </Button>
          </Tooltip>,
          workspaceHost,
        )}
      {edges.map((edge) => {
        const entries = workbenchPanels
          .entries()
          .filter(
            (panel) => panel.edge === edge && (panel.visibility !== 'contextual' || panel.when?.(context)),
          )
        if (entries.length === 0 && edge === 'bottom') return null
        const active = entries.find((panel) => panel.id === selected[edge]) ?? entries[0]
        const Component = active?.component
        const host = surfaces[`${edge}Content`]
        const open = layout[`${edge}Open`]
        return (
          <span key={edge}>
            <Button
              type="text"
              size="small"
              data-edge={edge}
              data-testid={`workbench-${edge}-toggle`}
              aria-controls={`workbench-${edge}`}
              aria-expanded={open}
              aria-label={t(`workbench.${edge}`)}
              title={t(`workbench.${edge}`)}
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
              <Icon name={edge === 'right' ? 'panel-right' : 'terminal'} size={18} />
              <span className="workbench-toggle-label">{t(`workbench.${edge}`)}</span>
            </Button>
            {host &&
              createPortal(
                <div className="workbench-dock-body">
                  <hr
                    className="workbench-resize"
                    hidden={edge === 'right' && expanded}
                    tabIndex={0}
                    aria-label={t('workbench.resize')}
                    aria-orientation={edge === 'right' ? 'vertical' : 'horizontal'}
                    aria-valuemin={edge === 'right' ? 240 : 120}
                    aria-valuemax={edge === 'right' ? 480 : Math.floor(window.innerHeight / 2)}
                    aria-valuenow={edge === 'right' ? layout.rightWidth : layout.bottomHeight}
                    onKeyDown={(event) => {
                      if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
                        event.preventDefault()
                        resize(edge, ['ArrowLeft', 'ArrowUp'].includes(event.key) ? 16 : -16)
                      }
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault()
                      const element = event.currentTarget
                      element.setPointerCapture(event.pointerId)
                      let position = edge === 'right' ? event.clientX : event.clientY
                      const move = (next: PointerEvent) => {
                        const coordinate = edge === 'right' ? next.clientX : next.clientY
                        resize(edge, position - coordinate)
                        position = coordinate
                      }
                      const end = () => {
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
                    <Tabs
                      className="workbench-dock-tabs"
                      {...(active ? { activeKey: active.id } : {})}
                      items={entries.map((panel) => ({
                        key: panel.id,
                        label: panel.title?.(context) ?? t(panel.titleKey),
                      }))}
                      renderTabBar={() => (
                        <div
                          role="tablist"
                          aria-label={t(`workbench.${edge}`)}
                          className="workbench-panel-tabs"
                        >
                          {entries
                            .slice(0, entries.length > 5 ? 4 : 5)
                            .concat(
                              entries.length > 5
                                ? active && entries.indexOf(active) >= 4
                                  ? [active]
                                  : entries.slice(4, 5)
                                : [],
                            )
                            .map((panel) => (
                              <Button
                                type="text"
                                size="small"
                                key={panel.id}
                                role="tab"
                                id={`workbench-tab-${panel.id}`}
                                data-testid={`workbench-tab-${panel.id}`}
                                aria-selected={active?.id === panel.id}
                                aria-controls={`workbench-panel-${edge}`}
                                tabIndex={active?.id === panel.id ? 0 : -1}
                                onClick={() => setSelected((value) => ({ ...value, [edge]: panel.id }))}
                                onKeyDown={(event) => {
                                  const index = entries.indexOf(panel)
                                  const step =
                                    event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                                  if (!step && event.key !== 'Home' && event.key !== 'End') return
                                  event.preventDefault()
                                  const next =
                                    entries[
                                      event.key === 'Home'
                                        ? 0
                                        : event.key === 'End'
                                          ? entries.length - 1
                                          : (index + step + entries.length) % entries.length
                                    ]
                                  if (next) {
                                    flushSync(() => setSelected((value) => ({ ...value, [edge]: next.id })))
                                    document.getElementById(`workbench-tab-${next.id}`)?.focus()
                                  }
                                }}
                              >
                                {sharedIcon(panel.icon) && <Icon name={panel.icon} />}
                                {panel.title?.(context) ?? t(panel.titleKey)}
                              </Button>
                            ))}
                        </div>
                      )}
                    />
                    {entries.length > 5 && (
                      <Menu
                        label={t('workbench.more')}
                        trigger={
                          <Button appearance="ghost" size="small">
                            {t('workbench.more')}
                          </Button>
                        }
                        items={entries.slice(4).map((panel) => ({
                          id: panel.id,
                          label: panel.title?.(context) ?? t(panel.titleKey),
                          onSelect: () => openPanel(panel.id),
                        }))}
                      />
                    )}
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
                                  mention: (path: string) => {
                                    leaveOverlay(edge)
                                    workbench.mention(path)
                                  },
                                }
                              : {}),
                            ...(active.id === 'facts'
                              ? {
                                  factChain: factTarget?.sessionId === sessionId ? factTarget : undefined,
                                }
                              : {}),
                          },
                        }}
                        headerId={`workbench-header-actions-${edge}`}
                      />
                    )}
                  </div>
                </div>,
                host,
              )}
          </span>
        )
      })}
    </div>
  )
  return workspaceHost ? createPortal(controlsView, workspaceHost) : controlsView
}
export function renderWorkbench(host: HTMLElement, context: UiExtensionContext): void {
  renderRegion(host, <Dock context={context} />)
}

export const unmountWorkbench = (host: HTMLElement): void => unmountRegion(host)
