import type { UiActionReceipt } from '@agnes/protocol/gen/intelligent-ui'
import { workbenchNavigation, type UiExtensionContext } from '@agnes/web-client'
import {
  Button,
  IntelligentSurface,
  intelligentUiCatalog,
  INTELLIGENT_UI_NAMESPACE,
  UiLocaleProvider,
  useUiText,
  type UiLocaleSource,
} from '@agnes/web-ui'
import { useCallback, useSyncExternalStore } from 'react'
import type { IntelligentUiClient } from './client.js'

export interface UiPlacementBinding {
  subscribe(listener: () => void): () => void
  getSnapshot(): IntelligentUiClient | undefined
  getVersion(): number
  locale: UiLocaleSource
  expand(surfaceId: string, revision: number): void
  target(): { sessionId: string; surfaceId: string; revision: number } | undefined
  approval(receipt: UiActionReceipt): void
}

export function IntelligentInline({ binding }: { binding: UiPlacementBinding }) {
  useSyncExternalStore(binding.subscribe, binding.getVersion)
  const client = binding.getSnapshot()
  return (
    <UiLocaleProvider source={binding.locale}>
      {client && <SurfaceList key={client.sessionId} binding={binding} client={client} placement="inline" />}
    </UiLocaleProvider>
  )
}
export function IntelligentPanel({
  binding,
  context,
}: {
  binding: UiPlacementBinding
  context: UiExtensionContext
}) {
  useSyncExternalStore(binding.subscribe, binding.getVersion)
  const client = binding.getSnapshot()
  // The dock can retain old context for one paint during a session switch. Fail closed.
  const session = (context.data as { session?: { id: string } } | undefined)?.session
  return (
    <UiLocaleProvider source={binding.locale}>
      <section data-testid="intelligent-ui-panel">
        {client && session?.id === client.sessionId ? (
          <SurfaceList key={client.sessionId} binding={binding} client={client} placement="workbench" />
        ) : (
          <Empty />
        )}
      </section>
    </UiLocaleProvider>
  )
}
function Empty() {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  return <p>{t('ui.empty')}</p>
}
function SurfaceList({
  binding,
  client,
  placement,
}: {
  binding: UiPlacementBinding
  client: IntelligentUiClient
  placement: 'inline' | 'workbench'
}) {
  useSyncExternalStore(client.subscribe, client.getVersion)
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const snapshot = client.getSnapshot(),
    target = binding.target()
  const sorted = [...snapshot.surfaces].sort((a, b) => {
    if (target?.sessionId === client.sessionId && placement === 'workbench') {
      if (a.surface.id === target.surfaceId) return -1
      if (b.surface.id === target.surfaceId) return 1
    }
    return Number(b.status === 'open') - Number(a.status === 'open') || b.updatedSeq - a.updatedSeq
  })
  return (
    <div data-testid={`intelligent-ui-${placement}`} aria-label={t('ui.title')}>
      {snapshot.error && <p role="alert">{t(snapshot.error)}</p>}
      {placement === 'workbench' && (
        <Button htmlType="button" data-testid="ui-refresh" onClick={() => void client.refresh()}>
          {t('ui.refresh')}
        </Button>
      )}
      {!sorted.length && placement === 'workbench' && <Empty />}
      {sorted.map((record) => (
        <BoundSurface
          key={`${record.surface.id}:${record.surface.revision}`}
          binding={binding}
          client={client}
          id={record.surface.id}
          placement={placement}
        />
      ))}
    </div>
  )
}
export function BoundSurface({
  binding,
  client,
  id,
  placement,
}: {
  binding: UiPlacementBinding
  client: IntelligentUiClient
  id: string
  placement: 'inline' | 'workbench'
}) {
  const record = client.record(id)!
  const draft = client.draft(id),
    receipts = client.receipts(id),
    confirmation = client.confirmation(id)
  const onInput = useCallback(
    (component: string, value: unknown) => client.setInput(id, component, value),
    [client, id],
  )
  const onSelection = useCallback(
    (component: string, ids: string[]) => client.setSelection(id, component, ids),
    [client, id],
  )
  const onInvalid = useCallback(
    (component: string, path: string, invalid: boolean) => client.setInvalid(id, component, path, invalid),
    [client, id],
  )
  return (
    <IntelligentSurface
      record={record}
      placement={placement}
      input={draft.input}
      selection={draft.selection}
      receipts={receipts}
      locked={client.locked(id)}
      invalid={draft.invalid.size > 0}
      needsReview={client.needsReview(id)}
      draftChanged={client.hasRevisionChange(id)}
      {...(confirmation ? { confirmation } : {})}
      transportPending={client
        .pendingCommands(id)
        .some((command) => !receipts.some((receipt) => receipt.commandId === command.commandId))}
      onInput={onInput}
      onSelection={onSelection}
      onInvalid={onInvalid}
      onAction={(action, row) => client.choose(id, action, row)}
      onConfirm={() => void client.confirm(id)}
      onCancel={() => client.cancelConfirmation(id)}
      onRetry={(receipt) => client.retry(receipt)}
      onReview={() => void client.review(id)}
      onRecover={() => void client.resend(id)}
      onExpand={() => binding.expand(id, record.surface.revision)}
      onApproval={binding.approval}
    />
  )
}

export const openIntelligentPanel = () => workbenchNavigation.open('intelligent-ui')
