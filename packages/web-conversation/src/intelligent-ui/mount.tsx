import type { UINode, UITurn } from '@agnes/protocol'
import type { UiActionReceipt } from '@agnes/protocol/gen/intelligent-ui'
import type { Client } from '@agnes/sdk/browser'
import {
  type ClientResourceService,
  conversationCards,
  type LocaleService,
  type SessionService,
  type SlotRegistry,
} from '@agnes/web-client'
import { createDocumentLocaleSource, INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { IntelligentUiClient } from './client.js'
import { answeredQuestions, foldedUserActions, renderedSurfaceIds } from './conversation.js'
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
import { AnsweredQuestions, QuestionAnswersNode, QuestionDock, questionSubmission } from './question-dock.js'
import { intelligentUiServer } from './server.js'
import { attachIntelligentBinding, TurnViews } from './turn-views.js'

/** One owned presentation across placements, dock and historical answer receipts. Mounting never submits. */
export function mountIntelligentUi(options: {
  contributions: Pick<import('@agnes/web-client').ClientContext, 'conversationCards' | 'workbenchPanels'>
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
    const id = options.session.sessionId
    const admitted = options.session.readiness.getSnapshot().status === 'ready'
    const sdkSession = admitted && id ? options.client.sessions.get(id) : undefined
    if (sdkSession && current?.sessionId === id) return
    stopWatch?.()
    stopWatch = undefined
    seenSurfaces = new Set()
    current?.dispose()
    current = undefined
    target = undefined
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
  // The conversation frame owns this declaration. Follow its lifetime, including when
  // the interaction module loads first or the selected frame is replaced.
  const removeInline = options.registry.inject('conversation.view', () =>
    options.registry.register(
      {
        name: 'conversation.view',
        id: 'builtin-intelligent-ui',
        owner: '@agnes/web-intelligent-ui',
        priority: 10,
      },
      () => <IntelligentInline binding={binding} />,
    ),
  )
  const listed = () => (current ? workbenchSurfaces(current.getSnapshot().surfaces) : [])
  // The tab counts the panels it shows; closed ones are listed below them with «show all».
  const shown = () => {
    if (!current) return 0
    const closed = hiddenSurfaces('panel', current.sessionId)
    return listed().filter((record) => !closed.has(record.surface.id)).length
  }
  const removePanel = options.contributions.workbenchPanels.register({
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
  const removeTurns = options.contributions.conversationCards.register({
    id: 'intelligent-turn-views',
    order: 100,
    matches: (card) => card.kind === 'conversation.turn-tail',
    component: ({ card }) => {
      const value = card.data as { turn: UITurn; nodes?: readonly UINode[]; surfaceIds?: readonly string[] }
      return (
        <TurnViews
          turn={value.turn}
          surfaceIds={value.surfaceIds ?? renderedSurfaceIds(value.nodes ?? [], value.turn)}
        />
      )
    },
  })
  const removeQuestions = [
    options.contributions.conversationCards.register({
      id: 'question-dock',
      order: 0,
      matches: (card) => card.kind === 'composer.before-input',
      component: QuestionDock,
    }),
    options.contributions.conversationCards.register({
      id: 'question-turn-actions',
      order: 0,
      matches: (card) => card.kind === 'conversation.turn-actions',
      hiddenNodeIds(nodes, turns) {
        const hidden = new Set(foldedUserActions(nodes))
        for (const answers of answeredQuestions(nodes, turns).values())
          for (const item of answers) hidden.add(item.nodeId)
        return [...hidden]
      },
      component: ({ card }) => {
        const { turn, nodes } = card.data as { turn: UITurn; nodes: readonly UINode[] }
        return <AnsweredQuestions answered={answeredQuestions(nodes, [turn]).get(turn.id) ?? []} />
      },
    }),
    options.contributions.conversationCards.register({
      id: 'question-answer-node',
      order: 0,
      matches: (card) => card.kind === 'conversation.node' && !!questionSubmission(card.data as UINode),
      component: ({ card, context }) => (
        <QuestionAnswersNode
          submission={questionSubmission(card.data as UINode)!}
          native={context.data as ReactNode}
        />
      ),
    }),
  ]
  const stopClaims = conversationCards.subscribe(notify)
  const stopSession = options.session.subscribe(switchSession)
  const stopReadiness = options.session.readiness.subscribe(switchSession)
  switchSession()
  return () => {
    stopSession()
    stopReadiness()
    stopWatch?.()
    current?.dispose()
    current = undefined
    removeInline()
    detachTurns()
    removePanel()
    removeTurns()
    for (const off of removeQuestions) off()
    stopClaims()
    removeLocale()
    documentLocale.dispose()
    listeners.clear()
  }
}
