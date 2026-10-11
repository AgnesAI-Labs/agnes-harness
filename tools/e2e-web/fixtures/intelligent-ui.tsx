import { Context } from '@agnes/cordis'
import type { UiActionParams, UiActionReceipt, UiReadResult } from '@agnes/protocol/gen/intelligent-ui'
import { LocaleService, ThemeService, workbenchNavigation, workbenchPanels } from '@agnes/web-client'
import {
  createAntdRoot,
  createDocumentLocaleSource,
  INTELLIGENT_UI_NAMESPACE,
  intelligentUiCatalog,
} from '@agnes/web-ui'
import { Approval } from '@agnes/web-units'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { IntelligentUiClient } from '../../../packages/web/src/intelligent-ui/client.js'
import {
  IntelligentInline,
  IntelligentPanel,
  type UiPlacementBinding,
} from '../../../packages/web/src/intelligent-ui/placements.js'
import type { IntelligentUiServer } from '../../../packages/web/src/intelligent-ui/types.js'
import { Dock } from '../../../packages/web/src/workbench/dock.js'
import { financeRecord, uiPage } from '../../../packages/web/test/intelligent-ui/fixture.js'

// Browser-only fake App Server with persisted synthetic facts. Real catalog, shared client,
// placements, dock and approval component; never executes a business tool or grants permission.
const key = 'intelligent-ui-fixture'
const state: { page: UiReadResult; requests: UiActionParams[] } = JSON.parse(
  localStorage.getItem(key) ?? 'null',
) ?? { page: uiPage(), requests: [] }
const sourceMode = new URL(location.href).searchParams.has('source')
let sourceRefreshes = 0
if (sourceMode) {
  const record = state.page.surfaces[0]!
  record.surface.data.rows = { $source: 'finance/differences', params: {} }
  record.sources = { rows: { status: 'pending' } }
  const action = record.surface.actions[0]!
  action.argsTemplate.amountCents = { from: 'data', key: 'rows', pointer: '/0/amountCents' }
  action.paramsSchema = {
    type: 'object',
    required: ['reason', 'amountCents'],
    properties: { reason: { type: 'string' }, amountCents: { type: 'integer' } },
  }
}
const customMode = new URL(location.href).searchParams.get('custom')
const customDeclaration = {
  kind: 'finance/reconcile/diff@1',
  propsSchema: {
    type: 'object',
    required: ['amount', 'fail'],
    properties: { amount: { type: 'integer' }, fail: { type: 'boolean' } },
    additionalProperties: false,
  },
  maxPropsBytes: 256,
  fallback: 'Review the preset differences table.',
  accessibility: { label: 'Reconciliation differences', keyboard: true as const },
}
if (customMode && !state.page.surfaces[0]!.surface.components.some((item) => item.id === 'custom')) {
  state.page.surfaces[0]!.surface.components.unshift({
    id: 'custom',
    kind: customDeclaration.kind,
    dataKey: 'custom',
    fallback: customDeclaration.fallback,
    actionIds: ['confirm'],
  })
  state.page.surfaces[0]!.surface.data.custom = { amount: 250, fail: customMode === 'error' }
}
const save = () => localStorage.setItem(key, JSON.stringify(state))
let onEvent: ((event: { seq: number; type: string }) => void) | undefined
const notify = () => {
  save()
  onEvent?.({
    seq: state.page.lastSeq,
    type: `x/agnes/intelligent-ui/action.${state.page.actions.at(-1)?.status ?? 'received'}`,
  })
}
const server: IntelligentUiServer = {
  read: async (params) =>
    structuredClone({
      ...state.page,
      ...(params.commandId
        ? {
            surfaces: [],
            actions: state.page.actions.filter((receipt) => receipt.commandId === params.commandId),
          }
        : {}),
    }),
  action: async (params) => {
    const previous = state.page.actions.find((receipt) => receipt.commandId === params.commandId)
    if (previous) return { ...previous, duplicate: true }
    state.requests.push(structuredClone(params))
    const record = state.page.surfaces[0]!
    const base: UiActionReceipt = {
      sessionId: params.sessionId,
      surfaceId: params.surfaceId,
      revision: params.revision,
      actionId: params.actionId,
      commandId: params.commandId,
      status: 'received',
      seq: ++state.page.lastSeq,
      duplicate: false,
    }
    const receipt: UiActionReceipt =
      record.surface.revision !== params.revision
        ? {
            ...base,
            status: 'rejected',
            refusal: {
              code: 'UI_STALE',
              reason: 'stale',
              message: 'Current data changed',
              currentRevision: record.surface.revision,
            },
          }
        : {
            ...base,
            status: 'pending-approval',
            invocationId: `invocation-${params.commandId}`,
            approvalId: `ticket-${params.commandId}`,
          }
    state.page.actions.push(receipt)
    notify()
    return structuredClone(receipt)
  },
  refresh: async () => {
    const record = state.page.surfaces[0]!
    if (sourceMode) {
      record.updatedSeq = ++state.page.lastSeq
      if (++sourceRefreshes === 1) record.sources = { rows: { status: 'error', code: 'UI_SOURCE_DENIED' } }
      else {
        record.surface.data.rows = [{ id: 'txn-1', amountCents: 275 }]
        record.sources = { rows: { status: 'ready', resultHash: 'ab'.repeat(32) } }
      }
      save()
    }
    return structuredClone(record)
  },
  listen: (listener) => {
    onEvent = listener
    return () => {
      onEvent = undefined
    }
  },
  attach: async () => {},
}
const language = new URL(location.href).searchParams.get('locale') === 'zh-CN' ? 'zh-CN' : 'en'
document.documentElement.lang = language
if (new URL(location.href).searchParams.get('theme') === 'dark')
  document.documentElement.classList.add('dark')
const locale = new LocaleService(new Context(), language)
locale.register(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
const source = createDocumentLocaleSource({ [INTELLIGENT_UI_NAMESPACE]: intelligentUiCatalog })
const client = new IntelligentUiClient('session-finance', server, sessionStorage)
let version = 0,
  target: ReturnType<UiPlacementBinding['target']>
const listeners = new Set<() => void>()
const binding: UiPlacementBinding = {
  ...(customMode
    ? {
        customModules: {
          theme: new ThemeService(new Context(), 'light'),
          subscribe: () => () => {},
          list: async () => [
            {
              rowId: 'web:finance',
              moduleName: 'finance',
              enabled: true,
              phase: customMode === 'blocked' ? ('blocked' as const) : ('ready' as const),
              revision: 'reviewed',
              contentDigest: `sha256-${'a'.repeat(64)}`,
              entryUrl: '/plugins/generations/11111111-1111-1111-1111-111111111111/finance/reviewed/diff.mjs',
              intelligentComponents: [customDeclaration],
            },
          ],
        },
      }
    : {}),
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: () => client,
  getVersion: () => version,
  locale: source.source,
  target: () => target,
  expand: (surfaceId, revision) => {
    target = { sessionId: client.sessionId, surfaceId, revision }
    version++
    for (const listener of listeners) listener()
    workbenchNavigation.open('intelligent-ui')
  },
  approval: () => {
    document.getElementById('approval')?.scrollIntoView()
    document.querySelector<HTMLButtonElement>('[data-testid="approval-action"]')?.focus()
  },
}
workbenchPanels.register({
  id: 'intelligent-ui',
  order: 1,
  edge: 'right',
  titleKey: 'ui.title',
  component: ({ context }) => <IntelligentPanel binding={binding} context={context} />,
})

function Fixture() {
  const [dockReady, setDockReady] = useState(false)
  useEffect(() => setDockReady(true), [])
  useSyncExternalStore(client.subscribe, client.getVersion)
  const pending = client.getSnapshot().receipts.find((receipt) => receipt.status === 'pending-approval')
  const decide = (allow: boolean) => {
    const receipt = state.page.actions.find((item) => item.commandId === pending?.commandId)!
    if (!allow) {
      Object.assign(receipt, {
        status: 'rejected',
        seq: ++state.page.lastSeq,
        refusal: { code: 'UI_UNAUTHORIZED', reason: 'unauthorized', message: 'Denied' },
      })
      notify()
      return
    }
    Object.assign(receipt, { status: 'executing', seq: ++state.page.lastSeq })
    notify()
    const resultSeq = ++state.page.lastSeq
    Object.assign(receipt, {
      status: 'succeeded',
      resultSeq,
      seq: ++state.page.lastSeq,
      summary: 'Simulated approval; posted: false',
    })
    const next = financeRecord(state.page.surfaces[0]!.surface.revision + 1)
    next.updatedSeq = ++state.page.lastSeq
    next.surface.data.rows = [{ id: 'txn-1', amountCents: 250, status: 'simulated-approved' }]
    state.page.surfaces = [next]
    notify()
  }
  return (
    <main className="workbench-split" style={{ overflow: 'auto', height: '100vh' }}>
      <div id="fixture-controls">
        {dockReady && (
          <Dock
            context={{
              t: (name) => locale.t(name),
              data: { session: { id: client.sessionId }, disabled: false },
            }}
          />
        )}
      </div>
      <IntelligentInline binding={binding} />
      <section id="approval">
        {pending && (
          <Approval
            key={pending.commandId}
            initialView={{
              key: pending.approvalId!,
              title: language === 'en' ? 'Tool permission' : '工具权限审批',
              summary: 'fde_finance_approve · simulated only',
              impact: 'The original ticket is preserved across reload.',
              preview: JSON.stringify(
                state.requests.find((item) => item.commandId === pending.commandId)?.input ?? {},
              ),
              disabled: false,
              actions: [
                {
                  id: 'allow',
                  label: language === 'en' ? 'Allow once' : '仅允许这次',
                  onSelect: () => decide(true),
                },
                { id: 'deny', label: language === 'en' ? 'Deny' : '拒绝', onSelect: () => decide(false) },
              ],
            }}
          />
        )}
      </section>
      <button
        data-testid="fixture-change-data"
        type="button"
        onClick={() => {
          const next = financeRecord(state.page.surfaces[0]!.surface.revision + 1)
          next.updatedSeq = ++state.page.lastSeq
          state.page.surfaces = [next]
          save()
        }}
      >
        Simulate concurrent revision without event delivery
      </button>
      <p data-testid="fixture-command-count">{state.requests.length}</p>
      {sourceMode && (
        <p data-testid="fixture-source-hashes">{JSON.stringify(state.requests.at(-1)?.sources ?? {})}</p>
      )}
      <aside id="workbench-right" hidden>
        <div id="workbench-right-content" />
      </aside>
      <aside id="workbench-bottom" hidden>
        <div id="workbench-bottom-content" />
      </aside>
    </main>
  )
}
await client.start()
createAntdRoot(document.getElementById('fixture-root')!).render(<Fixture />)
addEventListener(
  'pagehide',
  () => {
    client.dispose()
    source.dispose()
  },
  { once: true },
)
