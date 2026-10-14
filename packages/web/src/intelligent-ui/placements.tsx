import type { UiActionReceipt, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { type ClientResourceService, type UiExtensionContext, workbenchNavigation } from '@agnes/web-client'
import {
  Button,
  docksInConversation,
  INTELLIGENT_UI_NAMESPACE,
  IntelligentSurface,
  intelligentUiCatalog,
  isDeliverableList,
  Menu,
  SettingsState,
  surfaceTitle,
  UiLocaleProvider,
  type UiLocaleSource,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ArtifactFile } from './artifact-file.js'
import type { IntelligentUiClient } from './client.js'
import { CustomUiHost, type CustomUiModuleSource } from './custom-host.js'

export interface UiPlacementBinding {
  resources?: ClientResourceService
  subscribe(listener: () => void): () => void
  getSnapshot(): IntelligentUiClient | undefined
  getVersion(): number
  customModules?: CustomUiModuleSource
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
  return <SettingsState>{t('ui.empty')}</SettingsState>
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
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  useEffect(() => {
    if (placement !== 'inline') return
    const host = document.getElementById('workbench-right')
    if (!host) return
    const read = () =>
      setWorkbenchOpen(
        !host.hidden && !!host.querySelector('#workbench-tab-intelligent-ui[aria-selected="true"]'),
      )
    read()
    const observer = new MutationObserver(read)
    observer.observe(host, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['hidden', 'aria-selected'],
    })
    return () => observer.disconnect()
  }, [placement])
  const [dismissed, setDismissed] = useState(() => readDismissed(client.sessionId))
  const dismiss = (id: string) =>
    setDismissed((current) => {
      const next = new Set(current).add(id)
      try {
        sessionStorage.setItem(DISMISSED_KEY + client.sessionId, JSON.stringify([...next]))
      } catch {
        /* browser policy may disallow storage */
      }
      return next
    })
  const snapshot = client.getSnapshot(),
    target = binding.target()
  const sorted = snapshot.surfaces
    .filter((record) => placement === 'inline' || record.surface.placement.workbench)
    .sort((a, b) => {
      if (target?.sessionId === client.sessionId && placement === 'workbench') {
        if (a.surface.id === target.surfaceId) return -1
        if (b.surface.id === target.surfaceId) return 1
      }
      return Number(b.status === 'open') - Number(a.status === 'open') || b.updatedSeq - a.updatedSeq
    })
  const bound = (record: UiSurfaceRecord) => (
    <BoundSurface
      key={`${record.surface.id}:${record.surface.revision}`}
      binding={binding}
      client={client}
      id={record.surface.id}
      placement={placement}
      workbenchOpen={workbenchOpen}
      {...(placement === 'inline' ? { onDismiss: () => dismiss(record.surface.id) } : {})}
    />
  )
  // In the conversation a surface is either a full card or a one-line chip pointing at the workbench.
  const docked =
    placement === 'inline'
      ? sorted.filter((record) => docksInConversation(record.surface) && !dismissed.has(record.surface.id))
      : []
  // Files are shown inside the answer of the turn that produced them, not after the conversation.
  const cards =
    placement === 'inline'
      ? sorted.filter((record) => !docksInConversation(record.surface) && !isDeliverableList(record.surface))
      : sorted
  const overflow = docked.slice(DOCK_VISIBLE)
  return (
    <section
      className={placement === 'inline' ? 'agnes-intelligent-inline' : undefined}
      data-testid={`intelligent-ui-${placement}`}
      aria-label={t('ui.title')}
    >
      {snapshot.error && <SettingsState tone="error">{t(snapshot.error)}</SettingsState>}
      {placement === 'workbench' && snapshot.error && (
        <Button htmlType="button" data-testid="ui-refresh" onClick={() => void client.refresh()}>
          {t('ui.refresh')}
        </Button>
      )}
      {!sorted.length && placement === 'workbench' && <Empty />}
      {cards.map(bound)}
      {docked.length > 0 && (
        <nav className="agnes-intelligent-dock" data-testid="ui-dock" aria-label={t('ui.dock.label')}>
          {docked.slice(0, DOCK_VISIBLE).map(bound)}
          {overflow.length > 0 && (
            <Menu
              label={t('ui.dock.moreLabel', { count: overflow.length })}
              trigger={
                <Button
                  htmlType="button"
                  appearance="ghost"
                  data-testid="ui-dock-more"
                  aria-label={t('ui.dock.moreLabel', { count: overflow.length })}
                >
                  {t('ui.dock.more', { count: overflow.length })}
                </Button>
              }
              items={overflow.map((record) => ({
                id: record.surface.id,
                label: surfaceTitle(record.surface, t),
                onSelect: () => binding.expand(record.surface.id, record.surface.revision),
              }))}
            />
          )}
        </nav>
      )}
    </section>
  )
}
const DOCK_VISIBLE = 2
const DISMISSED_KEY = 'agnes.ui.dock.dismissed:'
function readDismissed(sessionId: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(DISMISSED_KEY + sessionId) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}
export function BoundSurface({
  binding,
  client,
  id,
  placement,
  workbenchOpen,
  onDismiss,
}: {
  binding: UiPlacementBinding
  client: IntelligentUiClient
  id: string
  placement: 'inline' | 'workbench'
  workbenchOpen?: boolean
  onDismiss?: () => void
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
  const renderCustom = useCallback(
    (props: import('@agnes/web-ui').CustomUiRenderProps) =>
      binding.customModules ? (
        <CustomUiHost {...props} sessionId={client.sessionId} source={binding.customModules} />
      ) : null,
    [binding.customModules, client.sessionId],
  )
  return (
    <IntelligentSurface
      renderArtifact={(file) => (
        <ArtifactFile
          key={file.artifact.sha256}
          file={file}
          laneId={record.lane}
          resources={binding.resources}
          placement={placement}
          {...(placement === 'inline' && record.surface.placement.workbench
            ? { onShowInWorkbench: () => binding.expand(id, record.surface.revision) }
            : {})}
        />
      )}
      {...(binding.customModules ? { renderCustom } : {})}
      record={record}
      placement={placement}
      workbenchOpen={workbenchOpen}
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
      onRefreshSource={() => void client.refreshSource(id)}
      onConfirm={() => void client.confirm(id)}
      onCancel={() => client.cancelConfirmation(id)}
      onRetry={(receipt) => client.retry(receipt)}
      onReview={() => void client.review(id)}
      onRecover={() => void client.resend(id)}
      onExpand={() => binding.expand(id, record.surface.revision)}
      onDismiss={onDismiss}
      onApproval={binding.approval}
    />
  )
}

export const openIntelligentPanel = () => workbenchNavigation.open('intelligent-ui')

/**
 * Only the first appearance may bring a surface forward. Revision updates never steal focus.
 * Dual placements leave the complete view in the workbench and a summary in the conversation.
 */
export function newSurfacePlacements(
  seen: ReadonlySet<string>,
  surfaces: readonly UiSurfaceRecord[],
): { keys: string[]; showConversation: boolean; showWorkbench: boolean } {
  const keys: string[] = []
  let showConversation = false
  let showWorkbench = false
  for (const record of surfaces) {
    const key = record.surface.id
    if (seen.has(key)) continue
    keys.push(key)
    if (record.status !== 'open') continue
    showConversation = true
    if (record.surface.placement.workbench && !record.surface.placement.inline) showWorkbench = true
  }
  return { keys, showConversation, showWorkbench }
}
