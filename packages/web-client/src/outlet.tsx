/** React outlet with per-entry error isolation and priority-aware projection. */
import type { ComponentType, ReactElement, ReactNode } from 'react'
import {
  Component,
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { SlotRegistry } from './registry.js'
import type { ClientResourceService, LocaleService, SessionService } from './services.js'
import type { ChainRenderOpts, SlotEntry, SlotName, SlotProps } from './slots.js'

const SlotsContext = createContext<SlotRegistry | undefined>(undefined)
const SlotRuntimeContext = createContext<SlotRuntime>({
  session: undefined,
  locale: undefined,
  resources: undefined,
})
const noSubscribe = () => () => undefined
const noSnapshot = (): undefined => undefined

interface SlotRuntime {
  session: SessionService | undefined
  locale: LocaleService | undefined
  resources: ClientResourceService | undefined
}

export function SlotsProvider({
  registry,
  children,
  session,
  locale,
  resources,
}: {
  registry: SlotRegistry
  children?: ReactNode
  session?: SessionService
  locale?: LocaleService
  resources?: ClientResourceService
}): ReactElement {
  useEffect(() => {
    if (!session) return
    return registry.bindSession(session)
  }, [registry, session])
  const runtimeValue: SlotRuntime = { session, locale, resources }
  return createElement(
    SlotsContext.Provider,
    { value: registry },
    createElement(SlotRuntimeContext.Provider, { value: runtimeValue }, children),
  )
}

export interface SlotOutletProps<N extends SlotName = SlotName> {
  name: N
  props?: SlotProps<N>
  filterEntry?: ((entry: SlotEntry) => boolean) | undefined
  hideWhenEmpty?: boolean | undefined
  /** Shadowing outlets retire a broken occupant so the next priority can render. */
  abdicateOnError?: boolean | undefined
  /** Owner passed to chain selectors. Defaults to the outlet props. */
  owner?: unknown
  /** Business key selected by a keyed owner. */
  entryKey?: string
  /** Fallback used by chain slots when every selector declines. */
  fallback?: ReactNode
  /** Keep the chain fallback mounted (hidden) while a winner is active. */
  overlay?: boolean | undefined
  /** Grouped chain options; `owner`/`overlay` remain accepted for compatibility. */
  chain?: ChainRenderOpts | undefined
}

export function SlotOutlet<N extends SlotName>(outletProps: SlotOutletProps<N>): ReactElement {
  const registry = useContext(SlotsContext)
  const runtime = useContext(SlotRuntimeContext)
  if (!registry) throw new Error('SlotOutlet requires <SlotsProvider registry={...}>')
  const version = useSyncExternalStore(
    (listener) => registry.subscribeBatched(outletProps.name, listener),
    () => registry.getVersion(outletProps.name),
  )
  const sessionId = runtime.session?.getSnapshot() ?? registry.sessionId
  const sessionSubscribe = runtime.session
    ? runtime.session.subscribe
    : (listener: () => void) => registry.subscribeSession(listener)
  const sessionSnapshot = runtime.session ? runtime.session.getSnapshot : () => registry.sessionId
  const sessionVersion = useSyncExternalStore(sessionSubscribe, sessionSnapshot)
  const localeVersion = useSyncExternalStore(
    runtime.locale ? runtime.locale.subscribe : registry.subscribeLocale.bind(registry),
    runtime.locale ? runtime.locale.getSnapshot : () => String(registry.getLocaleVersion()),
  )
  void version
  void sessionVersion
  void localeVersion
  const spec = registry.spec(outletProps.name)
  // Root entries outlive the active conversation. Re-keying them on session changes
  // detaches DOM controllers and incorrectly allocates another root store seat.
  const scopeKey =
    spec?.scope === 'session'
      ? (sessionId ?? 'root')
      : spec?.scope === 'session-maybe'
        ? (sessionId ?? 'empty')
        : 'root'
  const unavailable = spec?.scope === 'session' && sessionId === undefined
  const maybeIncarnation = useRef<{ sessionId: string | undefined; value: number }>({
    sessionId,
    value: 0,
  })
  if (spec?.scope === 'session-maybe') {
    const previous = maybeIncarnation.current.sessionId
    const changedBetweenConcreteSessions =
      previous !== undefined && sessionId !== undefined && previous !== sessionId
    const returnedFromConcreteSession = previous !== undefined && sessionId === undefined
    if (changedBetweenConcreteSessions || returnedFromConcreteSession) maybeIncarnation.current.value += 1
    maybeIncarnation.current.sessionId = sessionId
  }
  const componentScopeKey =
    spec?.scope === 'session-maybe'
      ? `${outletProps.name}:maybe:${maybeIncarnation.current.value}`
      : `${outletProps.name}:${scopeKey}`
  const chainOverlay = outletProps.overlay ?? outletProps.chain?.overlay ?? false
  const chainOwner = outletProps.owner ?? outletProps.chain?.owner
  const fallback =
    outletProps.fallback ??
    (outletProps.chain?.fallback as ReactNode | undefined) ??
    createElement('div', { 'data-slot-placeholder': '1' }, '此槽位的插件未就绪')

  if (spec?.kind === 'chain') {
    const selected =
      !unavailable || chainOverlay
        ? registry.selectChain(outletProps.name, chainOwner ?? outletProps.props ?? null)
        : undefined
    const winner =
      selected && safeFilter(outletProps.filterEntry, selected.entry as SlotEntry)
        ? { ...selected, entry: selected.entry as SlotEntry }
        : undefined
    if (!winner && outletProps.hideWhenEmpty) {
      return createElement('div', {
        'data-slot': outletProps.name,
        'data-slot-state': 'empty',
        hidden: true,
      })
    }
    const fallbackNode = createElement(
      'div',
      {
        'data-slot-fallback': outletProps.name,
        ...(winner && chainOverlay ? { style: { display: 'none' } } : {}),
      },
      fallback,
    )
    const nodes: ReactNode[] = []
    if (winner) {
      nodes.push(
        createElement(SlotEntryBoundary, {
          key: `${winner.entry.key}:${componentScopeKey}`,
          scopeKey,
          entry: winner.entry,
          entryProps: outletProps.props,
          selectedValue: winner.value,
          registry,
          name: outletProps.name,
          sessionId,
          locale: runtime.locale,
          resources: runtime.resources,
          abdicate: outletProps.abdicateOnError ?? true,
        }),
      )
    }
    if (!winner || chainOverlay) nodes.push(fallbackNode)
    return createElement(
      'div',
      { 'data-slot': outletProps.name, 'data-slot-state': winner ? 'ready' : 'empty' },
      ...nodes,
    )
  }

  const all = unavailable ? [] : registry.entriesOfSlot(outletProps.name)
  const keyedEntries =
    spec?.kind === 'keyed' && outletProps.entryKey !== undefined
      ? all.filter((entry) => entry.options.key === outletProps.entryKey)
      : all
  const entries = outletProps.filterEntry
    ? keyedEntries.filter((entry) => safeFilter(outletProps.filterEntry, entry))
    : keyedEntries
  if (entries.length === 0) {
    if (outletProps.hideWhenEmpty) {
      return createElement('div', {
        'data-slot': outletProps.name,
        'data-slot-state': 'empty',
        hidden: true,
      })
    }
    return createElement('div', { 'data-slot': outletProps.name, 'data-slot-state': 'empty' }, fallback)
  }
  return createElement(
    'div',
    { 'data-slot': outletProps.name, 'data-slot-state': 'ready' },
    ...entries.map((entry) =>
      createElement(SlotEntryBoundary, {
        key: `${entry.key}:${componentScopeKey}`,
        scopeKey,
        entry,
        entryProps: outletProps.props,
        registry,
        name: outletProps.name,
        sessionId,
        locale: runtime.locale,
        resources: runtime.resources,
        abdicate: outletProps.abdicateOnError ?? (spec?.kind === 'single' || spec?.kind === 'keyed'),
      }),
    ),
  )
}

interface BoundaryProps {
  scopeKey: string
  entry: SlotEntry
  entryProps?: SlotProps<SlotName> | undefined
  registry: SlotRegistry
  name: SlotName
  abdicate: boolean
  selectedValue?: unknown
  sessionId: string | undefined
  locale: LocaleService | undefined
  resources: ClientResourceService | undefined
}

class SlotEntryBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    this.props.registry.reportEntryError(this.props.name, this.props.entry, error, {
      abdicate: this.props.abdicate,
    })
    // A rendered plugin controls its thrown value. Do not leak it or plugin metadata to the page
    // log; callers can correlate the safe runtime state through the host-owned registry.
    console.warn('[web-client] slot entry failed')
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return createElement(
        'div',
        { 'data-slot-entry': this.props.entry.key, 'data-slot-entry-state': 'failed' },
        '插件渲染失败',
      )
    }
    const store = this.props.registry.acquireStore(this.props.entry, this.props.scopeKey)
    return createElement(
      'div',
      { 'data-slot-entry': this.props.entry.key, 'data-slot-entry-state': 'ready' },
      createElement(EntryView, { ...this.props, store }),
    )
  }
}

function EntryView(props: BoundaryProps & { store: ReturnType<SlotRegistry['acquireStore']> }): ReactElement {
  const storeVersion = useSyncExternalStore(
    props.store?.subscribe ?? noSubscribe,
    props.store?.getSnapshot ?? noSnapshot,
  )
  void storeVersion
  const Comp = props.entry.component as unknown as ComponentType<Record<string, unknown>>
  const spec = props.registry.spec(props.name)
  const locale = props.locale ?? props.registry.getLocaleSource()
  const translate = props.entry.locale ? locale?.bind(props.entry.locale) : locale?.t.bind(locale)
  const baseProps = {
    ...(spec?.inject ?? {}),
    ...((props.entryProps ?? {}) as Record<string, unknown>),
    ...(props.selectedValue === undefined
      ? {}
      : {
          selected: props.selectedValue,
          value: props.selectedValue,
          ...(spec?.kind === 'chain' ? { matched: props.selectedValue } : {}),
        }),
    ...(props.store === undefined ? {} : { store: props.store }),
    ...(props.store?.actions === undefined ? {} : { actions: props.store.actions }),
    ...(spec?.scope === 'root' ? {} : { sessionId: props.sessionId }),
    ...(translate === undefined ? {} : { locale: translate }),
    ...(translate === undefined ? {} : { t: translate }),
    ...(props.resources === undefined ? {} : { resources: props.resources }),
  }
  const injected = props.entry.inject
    ? (Reflect.apply(props.entry.inject, undefined, injectArgs(spec?.scope, props.sessionId, props.store)) ??
      {})
    : {}
  return createElement(Comp, { ...baseProps, ...injected })
}

/**
 * DSH's inject face is positional so its parameter list can be inferred from
 * the slot scope and the declared store. Keep the renderer responsible for
 * supplying that list; business factories should not receive the React props
 * object or a mutable host context.
 */
function injectArgs(
  scope: NonNullable<ReturnType<SlotRegistry['spec']>>['scope'] | undefined,
  sessionId: string | undefined,
  store: ReturnType<SlotRegistry['acquireStore']>,
): unknown[] {
  if (scope === 'root') return store === undefined ? [] : [store.actions]
  if (scope === 'session-maybe') {
    return [sessionId, sessionId === undefined ? undefined : store?.actions]
  }
  return store === undefined ? [sessionId] : [sessionId, store.actions]
}

function safeFilter(filter: SlotOutletProps['filterEntry'], entry: SlotEntry): boolean {
  if (!filter) return true
  try {
    return filter(entry)
  } catch {
    // Filters are plugin-provided too, so their thrown values and metadata stay out of page logs.
    console.warn('[web-client] slot filter failed')
    return false
  }
}
