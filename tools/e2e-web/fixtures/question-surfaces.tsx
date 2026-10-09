import type { UiActionParams, UiActionReceipt, UiReadResult } from '@agnes/protocol'
import {
  createAntdRoot,
  createDocumentLocaleSource,
  INTELLIGENT_UI_NAMESPACE,
  intelligentUiCatalog,
} from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'
import { questionSurface } from '../../../packages/base/extensions/interaction/src/question.js'
import { IntelligentUiClient } from '../../../packages/web/src/intelligent-ui/client.js'
import {
  IntelligentInline,
  IntelligentPanel,
  type UiPlacementBinding,
} from '../../../packages/web/src/intelligent-ui/placements.js'
import type { IntelligentUiServer } from '../../../packages/web/src/intelligent-ui/types.js'

// Synthetic authenticated server; production placements/client. No provider or real execution.
const key = 'question-surface-fixture'
const surface = questionSurface('questions', [
  { id: 'single', question: 'Choose one', options: ['A', 'B'] },
  { id: 'multi', question: 'Choose several', options: ['A', 'B'], multiple: true, allowFreeText: true },
  { id: 'text', question: 'Explain' },
])
const initial: UiReadResult = {
  sessionId: 'session-question',
  lastSeq: 1,
  surfaces: [
    {
      surface,
      status: 'open',
      owner: 'agnes/intelligent-ui',
      taskId: 'task',
      lane: 'main',
      createdSeq: 1,
      updatedSeq: 1,
    },
  ],
  actions: [],
}
const state: { page: UiReadResult; requests: UiActionParams[]; deny: boolean } = JSON.parse(
  localStorage.getItem(key) ?? 'null',
) ?? { page: initial, requests: [], deny: false }
let listener: ((event: { seq: number; type: string }) => void) | undefined
const save = () => localStorage.setItem(key, JSON.stringify(state))
const notify = () => {
  save()
  listener?.({ seq: state.page.lastSeq, type: 'x/agnes/intelligent-ui/action.succeeded' })
}
const server: IntelligentUiServer = {
  read: async (params) =>
    structuredClone({
      ...state.page,
      ...(params.commandId
        ? { actions: state.page.actions.filter((a) => a.commandId === params.commandId), surfaces: [] }
        : {}),
    }),
  action: async (request) => {
    const old = state.page.actions.find((a) => a.commandId === request.commandId)
    if (old) return { ...old, duplicate: true }
    state.requests.push(structuredClone(request))
    const record = state.page.surfaces[0]!
    const receipt: UiActionReceipt = {
      sessionId: request.sessionId,
      surfaceId: request.surfaceId,
      revision: request.revision,
      actionId: request.actionId,
      commandId: request.commandId,
      status: 'received',
      seq: ++state.page.lastSeq,
      duplicate: false,
      ...(request.revision !== record.surface.revision
        ? {
            status: 'rejected',
            refusal: {
              code: 'UI_STALE',
              reason: 'stale',
              message: 'Data changed',
              currentRevision: record.surface.revision,
            },
          }
        : state.deny
          ? {
              status: 'rejected',
              refusal: { code: 'UI_UNAUTHORIZED', reason: 'unauthorized', message: 'Denied' },
            }
          : {}),
    }
    state.page.actions.push(receipt)
    notify()
    return structuredClone(receipt)
  },
  listen(onEvent) {
    listener = onEvent
    return () => {
      listener = undefined
    }
  },
  attach: async () => {},
}
const language = new URL(location.href).searchParams.get('locale') === 'zh-CN' ? 'zh-CN' : 'en'
document.documentElement.lang = language
const locale = createDocumentLocaleSource({ [INTELLIGENT_UI_NAMESPACE]: intelligentUiCatalog })
const client = new IntelligentUiClient('session-question', server, sessionStorage)
let target: ReturnType<UiPlacementBinding['target']>,
  version = 0
const listeners = new Set<() => void>()
const binding: UiPlacementBinding = {
  subscribe(callback) {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  },
  getSnapshot: () => client,
  getVersion: () => version,
  locale: locale.source,
  target: () => target,
  expand(surfaceId, revision) {
    target = { sessionId: client.sessionId, surfaceId, revision }
    version++
    for (const fn of listeners) fn()
  },
  approval: () => {},
}
function Fixture() {
  useSyncExternalStore(client.subscribe, client.getVersion)
  useSyncExternalStore(binding.subscribe, binding.getVersion)
  return (
    <main>
      <IntelligentInline binding={binding} />
      {target && (
        <IntelligentPanel
          binding={binding}
          context={{ t: (key) => key, data: { session: { id: client.sessionId } } }}
        />
      )}
      <output data-testid="fixture-requests">{JSON.stringify(state.requests)}</output>
      <button
        type="button"
        data-testid="fixture-complete"
        onClick={() => {
          const receipt = state.page.actions.at(-1)!
          if (receipt.status !== 'received') return
          receipt.status = 'succeeded'
          receipt.resultSeq = ++state.page.lastSeq
          receipt.seq = ++state.page.lastSeq
          receipt.summary = JSON.stringify(state.requests.at(-1)?.input)
          state.page.surfaces[0]!.status = 'closed'
          notify()
        }}
      >
        Complete deferred collector
      </button>
      <button
        type="button"
        data-testid="fixture-change"
        onClick={() => {
          state.page.surfaces[0]!.surface.revision++
          state.page.surfaces[0]!.updatedSeq = ++state.page.lastSeq
          save()
        }}
      >
        Change revision without notification
      </button>
      <button
        type="button"
        data-testid="fixture-deny"
        onClick={() => {
          state.deny = true
          save()
        }}
      >
        Deny next collector
      </button>
    </main>
  )
}
await client.start()
createAntdRoot(document.getElementById('fixture-root')!).render(<Fixture />)

addEventListener(
  'pagehide',
  () => {
    client.dispose()
    locale.dispose()
  },
  { once: true },
)
