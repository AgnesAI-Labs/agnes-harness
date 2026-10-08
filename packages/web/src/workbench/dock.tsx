import type { FactChainParams } from '@agnes/protocol'
import {
  factChainLinks,
  type UiExtensionContext,
  workbenchNavigation,
  workbenchPanels,
} from '@agnes/web-client'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import { Button, renderRegion, unmountRegion } from '@agnes/web-ui'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

type Layout = { rightOpen: boolean; bottomOpen: boolean; rightWidth: number; bottomHeight: number }
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
  const [layout, setLayout] = useState(readLayout)
  const [factTarget, setFactTarget] = useState<FactChainParams>()
  const returnFocus = useRef<HTMLElement | null>(null)
  const sessionId = (context.data as WorkbenchContext)?.session?.id
  const [selected, setSelected] = useState({ right: 'files', bottom: 'terminal' })
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
  useEffect(() => {
    setFactTarget(undefined)
    const openPanel = (id: string) => {
      const panel = workbenchPanels.get(id)
      if (!panel) return false
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
  }, [sessionId])
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
    } catch {
      /* in-memory layout remains usable */
    }
    const split = surfaces.split
    if (!split) return
    split.classList.toggle('workbench-right-open', layout.rightOpen)
    split.classList.toggle('workbench-bottom-open', layout.bottomOpen)
    split.style.setProperty('--workbench-width', `${layout.rightWidth}px`)
    split.parentElement?.style.setProperty('--workbench-width', `${layout.rightWidth}px`)
    split.style.setProperty('--workbench-height', `${layout.bottomHeight}px`)
    for (const edge of edges) {
      const host = surfaces[edge]
      if (host) host.hidden = !layout[`${edge}Open`]
    }
  }, [layout, surfaces])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const edge = edges.find(
        (value) => layout[`${value}Open`] && surfaces[value]?.contains(event.target as Node),
      )
      if (!edge || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        setLayout((value) => ({ ...value, [`${edge}Open`]: false }))
        if (returnFocus.current?.isConnected) returnFocus.current.focus()
        else controls.current?.querySelector<HTMLButtonElement>(`[data-edge="${edge}"]`)?.focus()
      }
      if (event.key === 'Tab' && window.innerWidth < 1280) {
        const nodes = [
          ...(surfaces[edge]?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input, textarea, [tabindex="0"]',
          ) ?? []),
        ].filter((node) => node.tabIndex >= 0)
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
  }, [layout, surfaces])
  const close = (edge: 'right' | 'bottom') => {
    setLayout((value) => ({ ...value, [`${edge}Open`]: false }))
    if (returnFocus.current?.isConnected) returnFocus.current.focus()
    else controls.current?.querySelector<HTMLButtonElement>(`[data-edge="${edge}"]`)?.focus()
  }
  const resize = (edge: 'right' | 'bottom', amount: number) =>
    setLayout((value) => ({
      ...value,
      ...(edge === 'right'
        ? { rightWidth: Math.max(240, Math.min(480, value.rightWidth + amount)) }
        : { bottomHeight: Math.max(120, Math.min(window.innerHeight / 2, value.bottomHeight + amount)) }),
    }))
  return (
    <div ref={controls} className="workbench-controls">
      {edges.map((edge) => {
        const entries = workbenchPanels.entries().filter((panel) => panel.edge === edge)
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
              onClick={() => {
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
              <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                {edge === 'right' ? (
                  <>
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M15 4v16" />
                  </>
                ) : (
                  <>
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M3 14h18" />
                  </>
                )}
              </svg>
            </Button>
            {host &&
              createPortal(
                <div className="workbench-dock-body">
                  <hr
                    className="workbench-resize"
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
                    <div role="tablist" aria-label={t(`workbench.${edge}`)} className="workbench-panel-tabs">
                      {entries.map((panel, index) => (
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
                            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
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
                              setSelected((value) => ({ ...value, [edge]: next.id }))
                              document.getElementById(`workbench-tab-${next.id}`)?.focus()
                            }
                          }}
                        >
                          {t(panel.titleKey)}
                        </Button>
                      ))}
                    </div>
                    <div id={`workbench-header-actions-${edge}`} className="workbench-header-actions" />
                    <Button
                      type="text"
                      size="small"
                      aria-label={t('workbench.close')}
                      onClick={() => close(edge)}
                    >
                      ×
                    </Button>
                  </div>
                  <div
                    role="tabpanel"
                    id={`workbench-panel-${edge}`}
                    aria-labelledby={active ? `workbench-tab-${active.id}` : undefined}
                    className="workbench-panel-content"
                  >
                    {Component && open && (
                      <Component
                        key={active.id}
                        context={
                          active.id === 'facts'
                            ? {
                                ...context,
                                data: {
                                  ...(context.data as WorkbenchContext),
                                  factChain: factTarget?.sessionId === sessionId ? factTarget : undefined,
                                },
                              }
                            : context
                        }
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
}
export function renderWorkbench(host: HTMLElement, context: UiExtensionContext): void {
  renderRegion(host, <Dock context={context} />)
}

export const unmountWorkbench = (host: HTMLElement): void => unmountRegion(host)
