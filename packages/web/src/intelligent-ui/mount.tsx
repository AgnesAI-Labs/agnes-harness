import type { UiActionReceipt } from '@agnes/protocol/gen/intelligent-ui'
import type { Client } from '@agnes/sdk/browser'
import {
  type ClientResourceService,
  conversationCards,
  type LocaleService,
  type SessionService,
  type SlotRegistry,
  workbenchPanels,
} from '@agnes/web-client'
import { createDocumentLocaleSource, INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from '@agnes/web-ui'
import { IntelligentUiClient } from './client.js'
import type { CustomUiModuleSource } from './custom-host.js'
import {
  hiddenSurfaces,
  IntelligentInline,
  IntelligentPanel,
  locateInConversation,
  newSurfacePlacements,
  openIntelligentPanel,
  setSurfaceHidden,
  subscribeSurfaceChoices,
  type UiPlacementBinding,
  workbenchSurfaces,
} from './placements.js'
import { intelligentUiServer } from './server.js'
import { attachIntelligentBinding, TurnViews } from './turn-views.js'

/** Two registrations, one session client. Mounting a placement never submits a command. */
export function mountIntelligentUi(options: {
  resources?: ClientResourceService
  customModules?: CustomUiModuleSource
  client: Client
  registry: SlotRegistry
  session: SessionService
  locale: LocaleService
  approval(receipt: UiActionReceipt): void
  /** Bring the conversation card out from under the trace pane. */
  revealInline?(): void
}): () => void {
  let current: IntelligentUiClient | undefined
  let stopWatch: (() => void) | undefined
  let seenSurfaces = new Set<string>()
  let target: ReturnType<UiPlacementBinding['target']>
  const listeners = new Set<() => void>()
  const documentLocale = createDocumentLocaleSource({ [INTELLIGENT_UI_NAMESPACE]: intelligentUiCatalog })
  const removeLocale = options.locale.register(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  let version = 0
  const notify = () => {
    version++
    for (const listener of listeners) listener()
  }
  const binding: UiPlacementBinding = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => current,
    getVersion: () => version,
    ...(options.resources ? { resources: options.resources } : {}),
    ...(options.customModules ? { customModules: options.customModules } : {}),
    locale: documentLocale.source,
    target: () => target,
    expand: (surfaceId, revision) => {
      if (!current || current.record(surfaceId)?.surface.revision !== revision) return
      target = { sessionId: current.sessionId, surfaceId, revision }
      // Asking for a panel opens it again if it was closed in the workbench.
      setSurfaceHidden('panel', current.sessionId, surfaceId, false)
      openIntelligentPanel()
      notify()
    },
    locate: (surfaceId) => {
      if (!current) return
      setSurfaceHidden('dock', current.sessionId, surfaceId, false)
      options.revealInline?.()
      // Let a chip that was hidden render, and the trace pane step aside, before scrolling.
      window.setTimeout(() => requestAnimationFrame(() => locateInConversation(surfaceId)), 0)
    },
    approval: (receipt) => {
      if (current?.sessionId === receipt.sessionId && receipt.status === 'pending-approval')
        options.approval(receipt)
    },
  }
  const switchSession = () => {
    stopWatch?.()
    stopWatch = undefined
    seenSurfaces = new Set()
    current?.dispose()
    current = undefined
    target = undefined
    const id = options.session.sessionId,
      sdkSession = id ? options.client.sessions.get(id) : undefined
    if (sdkSession) {
      let storage: Storage | undefined
      try {
        storage = sessionStorage
      } catch {
        /* browser policy may disallow storage */
      }
      const client = new IntelligentUiClient(
        sdkSession.id,
        intelligentUiServer(options.client, sdkSession),
        storage,
      )
      current = client
      let loaded = false
      stopWatch = client.subscribe(() => {
        const snapshot = client.getSnapshot()
        if (!snapshot.ready) return
        notify()
        const next = newSurfacePlacements(seenSurfaces, snapshot.surfaces)
        for (const key of next.keys) seenSurfaces.add(key)
        if (!loaded) {
          loaded = true
          return
        }
        if (next.showConversation) options.revealInline?.()
        if (next.showWorkbench) openIntelligentPanel()
      })
      void client.start()
    }
    notify()
  }
  // The existing conversation.view list is the only inline mount point; no timeline formats added.
  if (!options.registry.spec('conversation.view'))
    options.registry.declare(
      'conversation.view',
      { kind: 'list', scope: 'session' },
      'web-shell',
      'conversation.session',
    )
  const removeInline = options.registry.register(
    {
      name: 'conversation.view',
      id: 'builtin-intelligent-ui',
      owner: '@agnes/web-intelligent-ui',
      priority: 10,
    },
    () => <IntelligentInline binding={binding} />,
  )
  const listed = () => (current ? workbenchSurfaces(current.getSnapshot().surfaces) : [])
  // The tab counts the panels it shows; closed ones are listed below them with «show all».
  const shown = () => {
    if (!current) return 0
    const closed = hiddenSurfaces('panel', current.sessionId)
    return listed().filter((record) => !closed.has(record.surface.id)).length
  }
  const removePanel = workbenchPanels.register({
    id: 'intelligent-ui',
    order: 70,
    edge: 'right',
    titleKey: 'ui.title',
    visibility: 'contextual',
    when: (context) =>
      (context.data as { session?: { id: string } } | undefined)?.session?.id === current?.sessionId &&
      listed().length > 0,
    // The locale service's `t` is a method; pass a bound call, not the bare reference.
    title: () => options.locale.t('ui.title'),
    count: {
      subscribe: (listener) => {
        listeners.add(listener)
        const stopChoices = subscribeSurfaceChoices(listener)
        return () => {
          listeners.delete(listener)
          stopChoices()
        }
      },
      read: shown,
    },
    component: ({ context }) => <IntelligentPanel binding={binding} context={context} />,
  })
  const detachTurns = attachIntelligentBinding(binding)
  const removeTurns = conversationCards.register({
    id: 'intelligent-turn-views',
    order: 100,
    matches: (card) => card.kind === 'conversation.turn-tail',
    component: ({ card }) => {
      const value = card.data as { turn: import('@agnes/protocol').UITurn; surfaceIds: readonly string[] }
      return <TurnViews turn={value.turn} surfaceIds={value.surfaceIds} />
    },
  })
  const stopClaims = conversationCards.subscribe(notify)
  const stopSession = options.session.subscribe(switchSession)
  switchSession()
  return () => {
    stopSession()
    stopWatch?.()
    current?.dispose()
    current = undefined
    removeInline()
    detachTurns()
    removePanel()
    removeTurns()
    stopClaims()
    removeLocale()
    documentLocale.dispose()
    listeners.clear()
  }
}
