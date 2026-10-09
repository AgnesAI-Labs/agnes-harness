/**
 * The Devices panel inside the Agnes workbench (mhs-ui-design 4.1): a resizable dock on the right,
 * a sidebar entry, a full-screen console, and a card in the conversation for every brain device
 * tool. The page talks to AgnesHub's /ws/hub directly; language and theme follow the workbench.
 */
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import {
  BRAIN_TOOLS,
  type CardHost,
  CardHostContext,
  type Picture,
  ToolCard,
  type ToolNode,
} from '../../cards/cards.js'
import { Button, Chevron } from '../../controls/ui.js'
import { brainCalls } from '../../core/describe.js'
import { Store } from '../../core/store.js'
import type { Json } from '../../core/types.js'
import { catalogs, setLocale, t } from '../../i18n/i18n.js'
import { Activity } from '../../layout/activity.js'
import { type Brain, Panel } from '../../layout/panel.js'
import { type Nav, NavContext, StoreContext, useDevices, useLocale } from '../../react/hooks.js'
import '../../style.css'

const RAIL = 36
const MIN_WIDTH = 360
const SESSION_EVENT = '_agnes/v1/session.event'

// Minimal shapes of the host context this module uses (web-client ClientContext).
interface Ctx {
  slots: {
    register(name: string | Json, component: unknown, options?: Json): () => void
  }
  session: {
    sessionId: string | undefined
    handle: { listeners: Set<(method: string, params: Json) => void> } | undefined
    subscribe(listener: () => void): () => void
    projection: {
      read(): Promise<{ status: string; value?: unknown }>
      subscribe(listener: () => void): () => void
    }
  }
  agnes: {
    sessions?: { get(id: string): { readToolDetail(callSeq: number, resultSeq?: number): Promise<Json> } }
  }
  locale: {
    locale: string
    subscribe(listener: () => void): () => void
    register(ns: string, catalog: unknown): () => void
  }
  resources: {
    images: { load(input: { laneId: string; artifact: Picture }): Promise<{ url: string; release(): void }> }
  }
}

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Private windows: the layout is not remembered.
  }
}

const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, MIN_WIDTH), window.innerWidth * 0.75))

/** A tiny shared store for the dock's layout, the device shown, and what the brain is doing. */
function createUi() {
  let state = {
    open: load('mhs.dock.open', 'true') === 'true',
    width: clampWidth(Number(load('mhs.dock.width', '0')) || window.innerWidth * 0.36),
    full: false,
    device: undefined as string | undefined,
    brain: { thinking: false } as Brain,
  }
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set(patch: Partial<typeof state>) {
      state = { ...state, ...patch }
      save('mhs.dock.open', state.open)
      save('mhs.dock.width', state.width)
      for (const l of [...listeners]) l()
    },
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

export function apply(ctx: Ctx, config?: { publicConfig?: Json }) {
  const hubUrl = String(config?.publicConfig?.hubUrl ?? 'ws://127.0.0.1:4180/ws/hub')
  const store = new Store(hubUrl)
  const ui = createUi()
  const useUi = () => useSyncExternalStore(ui.subscribe, ui.get)

  setLocale(ctx.locale.locale)
  ctx.locale.subscribe(() => setLocale(ctx.locale.locale))
  ctx.locale.register('mhs-devices', catalogs)

  const nav: Nav = {
    get device() {
      return ui.get().device
    },
    open: (device) => ui.set({ device }),
  }

  const cardHost: CardHost = {
    async detail(node: ToolNode) {
      const id = ctx.session.sessionId
      const session = id ? ctx.agnes.sessions?.get(id) : undefined
      if (!session || node.resultSeq === undefined) return undefined
      const detail = await session.readToolDetail(node.seq, node.resultSeq)
      const result = detail.result as Json | undefined
      return result ? { structured: result.structured as Json, isError: result.isError === true } : undefined
    },
    image: (picture) => ctx.resources.images.load({ laneId: 'main', artifact: picture }),
    openDevice: (device) => ui.set({ device, open: true }),
  }

  function Providers(props: { children: ReactNode }) {
    const { device } = useUi()
    const value = { device, open: nav.open }
    return (
      <StoreContext.Provider value={store}>
        <NavContext.Provider value={value}>
          <CardHostContext.Provider value={cardHost}>{props.children}</CardHostContext.Provider>
        </NavContext.Provider>
      </StoreContext.Provider>
    )
  }

  // What the brain is doing, from the session's events: turns, and the device of its last call.
  // Events replayed when a session attaches are history, not activity.
  function useBrainEvents() {
    useEffect(() => {
      const since = Date.now() - 2000
      const calls = new Map<string, [string | undefined, string]>()
      let handle: Ctx['session']['handle']
      const listener = (method: string, params: Json) => {
        const event = params?.event as { type?: string; ts?: string; data?: Json } | undefined
        if (method !== SESSION_EVENT || !event || Date.parse(event.ts ?? '') < since) return
        if (event.type === 'turn/start') ui.set({ brain: { thinking: true } })
        else if (event.type === 'turn/end') ui.set({ brain: { thinking: false } })
        else if (
          event.type === 'tool/call' &&
          (BRAIN_TOOLS as readonly string[]).includes(String(event.data?.name))
        ) {
          const args = (event.data?.args as Json | undefined) ?? {}
          const device = typeof args.device === 'string' ? args.device : undefined
          const what =
            event.data?.name === 'call_device' ? String(args.tool ?? 'call') : String(event.data?.name)
          calls.set(String(event.data?.toolUseId), [device, what])
          store.brain(device, what, 'down')
          if (device) ui.set({ brain: { thinking: true, device } })
        } else if (event.type === 'tool/result' && calls.has(String(event.data?.toolUseId))) {
          const [device, what] = calls.get(String(event.data?.toolUseId)) as [string | undefined, string]
          calls.delete(String(event.data?.toolUseId))
          store.brain(device, what, 'up')
        }
      }
      const attach = () => {
        handle?.listeners.delete(listener)
        handle = ctx.session.handle
        handle?.listeners.add(listener)
      }
      attach()
      const stop = ctx.session.subscribe(attach)
      return () => {
        stop()
        handle?.listeners.delete(listener)
      }
    }, [])
  }

  /** The brain's device calls in the current conversation, from its UI projection. */
  function ActivityView() {
    const [calls, setCalls] = useState<ToolNode[] | undefined>()
    useEffect(() => {
      let live = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const read = () => {
        timer = undefined
        if (!ctx.session.sessionId) return setCalls(undefined)
        ctx.session.projection.read().then(
          (r) => {
            const nodes = (r.value as { nodes?: { kind?: string; name?: string }[] } | undefined)?.nodes
            if (live)
              setCalls(
                r.status === 'available' ? (brainCalls(nodes ?? []) as unknown as ToolNode[]) : undefined,
              )
          },
          () => undefined,
        )
      }
      // A turn sends many events; read at most twice a second.
      const soon = () => {
        timer ??= setTimeout(read, 500)
      }
      read()
      const stops = [ctx.session.subscribe(read), ctx.session.projection.subscribe(soon)]
      return () => {
        live = false
        clearTimeout(timer)
        for (const stop of stops) stop()
      }
    }, [])
    return <Activity calls={calls} />
  }

  function startDrag(event: React.PointerEvent) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.mhs-dock-toggle')) return
    event.preventDefault()
    document.body.classList.add('mhs-dragging')
    const move = (e: PointerEvent) => ui.set({ open: true, width: clampWidth(window.innerWidth - e.clientX) })
    const up = () => {
      document.body.classList.remove('mhs-dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function Dock() {
    useLocale()
    useBrainEvents()
    const { open, width, brain, full } = useUi()
    useEffect(() => {
      document.body.classList.add('mhs-docked')
      return () => {
        document.body.classList.remove('mhs-docked')
        document.documentElement.style.removeProperty('--mhs-w')
      }
    }, [])
    useEffect(() => {
      document.documentElement.style.setProperty('--mhs-w', `${open ? width : RAIL}px`)
    }, [open, width])
    return (
      <Providers>
        <section className="mhs-root mhs-dock" data-open={open} aria-label={t('app.title')}>
          <div className="mhs-seam" onPointerDown={startDrag} title={t('app.resize')}>
            <button
              type="button"
              className="mhs-dock-toggle"
              aria-label={open ? t('app.dock.close') : t('app.dock.open')}
              onClick={() => ui.set({ open: !open })}
            >
              <Chevron dir={open ? 'right' : 'left'} />
            </button>
          </div>
          {open && !full ? (
            <Panel
              brain={brain}
              activity={<ActivityView />}
              actions={
                <Button small kind="ghost" onClick={() => ui.set({ full: true })} title={t('app.expand')}>
                  ⤢
                </Button>
              }
            />
          ) : (
            <div className="mhs-rail-label">{t('app.title')}</div>
          )}
        </section>
      </Providers>
    )
  }

  function Console() {
    useLocale()
    const { full, brain } = useUi()
    useEffect(() => {
      if (!full) return
      const esc = (e: KeyboardEvent) => e.key === 'Escape' && ui.set({ full: false })
      window.addEventListener('keydown', esc)
      return () => window.removeEventListener('keydown', esc)
    }, [full])
    if (!full) return null
    return (
      <Providers>
        <div className="mhs-root mhs-console" role="dialog" aria-label={t('app.title')}>
          <Panel
            brain={brain}
            activity={<ActivityView />}
            actions={
              <Button small kind="ghost" onClick={() => ui.set({ full: false })} title={t('app.collapse')}>
                ⤡
              </Button>
            }
          />
        </div>
      </Providers>
    )
  }

  function SidebarEntryInner() {
    useLocale()
    const devices = useDevices()
    const { open } = useUi()
    const online = devices.filter((d) => d.available).length
    const attention = devices.filter((d) => d.health.level !== 'ok').length
    return (
      <button
        type="button"
        className="mhs-root mhs-nav"
        aria-pressed={open}
        onClick={() => ui.set({ open: !open })}
      >
        <svg className="mhs-nav-mark" viewBox="0 0 16 16" aria-hidden="true">
          {[
            [1.5, 1.5],
            [9, 1.5],
            [1.5, 9],
            [9, 9],
          ].map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="5.5" height="5.5" rx="1.5" />
          ))}
        </svg>
        <span>{t('app.title')}</span>
        <span className="mhs-dim">
          {online}/{devices.length}
        </span>
        {attention > 0 && <span className="mhs-warn-text">!{attention}</span>}
      </button>
    )
  }

  function SidebarEntry() {
    return (
      <Providers>
        <SidebarEntryInner />
      </Providers>
    )
  }

  function Card(props: { owner?: { block?: ToolNode } }) {
    return (
      <Providers>
        <div className="mhs-root">
          <ToolCard {...props} />
        </div>
      </Providers>
    )
  }

  ctx.slots.register('rightbar', Dock, { priority: -1 })
  ctx.slots.register('sidebar.panellist', SidebarEntry)
  ctx.slots.register('shell.overlay', Console)
  for (const key of BRAIN_TOOLS)
    ctx.slots.register({ name: 'tool.call.toolview', key, id: `mhs-card-${key}`, priority: 20 }, Card)
}
