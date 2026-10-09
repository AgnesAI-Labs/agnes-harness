import type { UiActionReceipt } from '@agnes/protocol/gen/intelligent-ui'
import type { Client } from '@agnes/sdk/browser'
import {
  type LocaleService,
  type SessionService,
  type SlotRegistry,
  workbenchPanels,
} from '@agnes/web-client'
import { createDocumentLocaleSource, INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from '@agnes/web-ui'
import { IntelligentUiClient } from './client.js'
import {
  IntelligentInline,
  IntelligentPanel,
  openIntelligentPanel,
  type UiPlacementBinding,
} from './placements.js'
import { intelligentUiServer } from './server.js'

/** Two registrations, one session client. Mounting a placement never submits a command. */
export function mountIntelligentUi(options: {
  client: Client
  registry: SlotRegistry
  session: SessionService
  locale: LocaleService
  approval(receipt: UiActionReceipt): void
}): () => void {
  let current: IntelligentUiClient | undefined
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
    locale: documentLocale.source,
    target: () => target,
    expand: (surfaceId, revision) => {
      if (!current || current.record(surfaceId)?.surface.revision !== revision) return
      target = { sessionId: current.sessionId, surfaceId, revision }
      openIntelligentPanel()
      notify()
    },
    approval: (receipt) => {
      if (current?.sessionId === receipt.sessionId && receipt.status === 'pending-approval')
        options.approval(receipt)
    },
  }
  const switchSession = () => {
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
      current = new IntelligentUiClient(
        sdkSession.id,
        intelligentUiServer(options.client, sdkSession),
        storage,
      )
      void current.start()
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
  const removePanel = workbenchPanels.register({
    id: 'intelligent-ui',
    order: 46,
    edge: 'right',
    titleKey: 'ui.title',
    component: ({ context }) => <IntelligentPanel binding={binding} context={context} />,
  })
  const stopSession = options.session.subscribe(switchSession)
  switchSession()
  return () => {
    stopSession()
    current?.dispose()
    current = undefined
    removeInline()
    removePanel()
    removeLocale()
    documentLocale.dispose()
    listeners.clear()
  }
}
