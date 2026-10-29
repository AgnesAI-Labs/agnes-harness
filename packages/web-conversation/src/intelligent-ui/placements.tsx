import type { UiActionReceipt, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import {
  type ClientResourceService,
  conversationCards,
  type UiExtensionContext,
  workbenchNavigation,
} from '@agnes/web-client'
import {
  Button,
  docksInConversation,
  INTELLIGENT_UI_NAMESPACE,
  IntelligentSurface,
  intelligentUiCatalog,
  Menu,
  rendersInAnswer,
  SettingsState,
  surfaceTitle,
  UiLocaleProvider,
  type UiLocaleSource,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { RegisteredConversationCard } from '../registered-card.js'
import type { IntelligentUiClient } from './client.js'
import { CustomUiHost, type CustomUiModuleSource } from './custom-host.js'
import { isQuestionSurface } from './question-dock.js'

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
  /** Scroll the conversation to a surface's card or chip, showing a hidden chip again first. */
  locate?(surfaceId: string): void
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
      <section className="agnes-intelligent-panel" data-testid="intelligent-ui-panel">
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
  useSyncExternalStore(conversationCards.subscribe, conversationCards.getSnapshot)
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
  useSyncExternalStore(subscribeSurfaceChoices, surfaceChoicesVersion)
  const dismissed = hiddenSurfaces('dock', client.sessionId)
  const closed = hiddenSurfaces('panel', client.sessionId)
  const snapshot = client.getSnapshot(),
    target = binding.target()
  // Questions are answered in their card above the composer and read back in the transcript.
  const listed =
    placement === 'inline'
      ? snapshot.surfaces.filter((record) => !isQuestionSurface(record))
      : workbenchSurfaces(snapshot.surfaces)
  const sorted = listed
    .filter((record) => placement === 'inline' || !closed.has(record.surface.id))
    .sort((a, b) => {
      if (target?.sessionId === client.sessionId && placement === 'workbench') {
        if (a.surface.id === target.surfaceId) return -1
        if (b.surface.id === target.surfaceId) return 1
      }
      return Number(b.status === 'open') - Number(a.status === 'open') || b.updatedSeq - a.updatedSeq
    })
  const hide = (id: string, hidden: boolean) => setSurfaceHidden('dock', client.sessionId, id, hidden)
  const bound = (record: UiSurfaceRecord) => {
    const id = record.surface.id
    const docked = docksInConversation(record.surface)
    // The workbench panel's ⋯ menu: find it in the conversation, hide or show its chip there, close it here.
    const panelMenu =
      placement === 'workbench'
        ? {
            ...(binding.locate && (docked || rendersInAnswer(record.surface))
              ? { onLocate: () => binding.locate?.(id) }
              : {}),
            ...(docked
              ? dismissed.has(id)
                ? { onRestore: () => hide(id, false) }
                : { onDismiss: () => hide(id, true) }
              : {}),
            onClose: () => setSurfaceHidden('panel', client.sessionId, id, true),
          }
        : { onDismiss: () => hide(id, true) }
    return (
      <BoundSurface
        key={`${id}:${record.surface.revision}`}
        binding={binding}
        client={client}
        id={id}
        placement={placement}
        workbenchOpen={workbenchOpen}
        {...panelMenu}
      />
    )
  }
  const closedHere = placement === 'workbench' ? listed.filter((record) => closed.has(record.surface.id)) : []
  // In the conversation a surface is either a full card or a one-line chip pointing at the workbench.
  const docked =
    placement === 'inline'
      ? sorted.filter((record) => docksInConversation(record.surface) && !dismissed.has(record.surface.id))
      : []
  // Files and inline views are shown inside the answer of the turn that produced them.
  const cards =
    placement === 'inline'
      ? sorted.filter(
          (record) =>
            !docksInConversation(record.surface) &&
            !conversationCards
              .entries()
              .some((card) => card.matches({ kind: 'intelligent-ui.surface', data: record })) &&
            !rendersInAnswer(record.surface),
        )
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
      {!sorted.length && placement === 'workbench' && !closedHere.length && <Empty />}
      {cards.map(bound)}
      {placement === 'workbench' && (sorted.length > 0 || closedHere.length > 0) && (
        <p className="agnes-intelligent-panel-foot" data-testid="ui-panel-foot">
          {closedHere.length > 0 && (
            <>
              <span data-testid="ui-panel-closed">{t('ui.closedCount', { count: closedHere.length })}</span>
              <Button
                htmlType="button"
                appearance="link"
                size="small"
                data-testid="ui-panel-restore"
                onClick={() => restoreSurfaces('panel', client.sessionId)}
              >
                {t('ui.closedRestore')}
              </Button>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>{t('ui.footnote')}</span>
        </p>
      )}
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

/**
 * Generic Views retain surfaces not claimed by another conversation presentation.
 */
export function workbenchSurfaces(surfaces: readonly UiSurfaceRecord[]): UiSurfaceRecord[] {
  return surfaces.filter(
    (record) =>
      !isQuestionSurface(record) &&
      record.surface.placement.workbench &&
      !conversationCards
        .entries()
        .some((card) => card.matches({ kind: 'intelligent-ui.surface', data: record })),
  )
}

/**
 * Presentation choices kept for the browser session: chips hidden from the conversation (`dock`)
 * and panels closed in the workbench (`panel`). They never change the surface itself.
 */
type SurfaceChoice = 'dock' | 'panel'
const CHOICE_KEYS: Record<SurfaceChoice, string> = {
  dock: 'agnes.ui.dock.dismissed:',
  panel: 'agnes.ui.panel.closed:',
}
const choices = new Map<string, ReadonlySet<string>>()
const choiceListeners = new Set<() => void>()
let choiceVersion = 0
export const surfaceChoicesVersion = () => choiceVersion
export function subscribeSurfaceChoices(listener: () => void): () => void {
  choiceListeners.add(listener)
  return () => {
    choiceListeners.delete(listener)
  }
}
export function hiddenSurfaces(kind: SurfaceChoice, sessionId: string): ReadonlySet<string> {
  const key = CHOICE_KEYS[kind] + sessionId
  const known = choices.get(key)
  if (known) return known
  let stored: ReadonlySet<string> = new Set()
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]')
    stored = new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
  } catch {
    /* browser policy may disallow storage */
  }
  choices.set(key, stored)
  return stored
}
function storeChoice(kind: SurfaceChoice, sessionId: string, next: ReadonlySet<string>) {
  const key = CHOICE_KEYS[kind] + sessionId
  choices.set(key, next)
  try {
    if (next.size) sessionStorage.setItem(key, JSON.stringify([...next]))
    else sessionStorage.removeItem(key)
  } catch {
    /* browser policy may disallow storage */
  }
  choiceVersion++
  for (const listener of [...choiceListeners]) listener()
}
export function setSurfaceHidden(kind: SurfaceChoice, sessionId: string, id: string, hidden: boolean) {
  const current = hiddenSurfaces(kind, sessionId)
  if (current.has(id) === hidden) return
  const next = new Set(current)
  if (hidden) next.add(id)
  else next.delete(id)
  storeChoice(kind, sessionId, next)
}
export function restoreSurfaces(kind: SurfaceChoice, sessionId: string) {
  if (hiddenSurfaces(kind, sessionId).size) storeChoice(kind, sessionId, new Set())
}

/** Bring a surface's card or chip in the conversation into view and mark it briefly. */
export function locateInConversation(surfaceId: string): boolean {
  const node = [...document.querySelectorAll<HTMLElement>('[data-placement="inline"]')].find(
    (element) => element.dataset.testid === `ui-surface-${surfaceId}`,
  )
  if (!node) return false
  let reduce = false
  try {
    reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    /* no media queries outside a browser */
  }
  node.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  if (!node.hasAttribute('tabindex')) node.tabIndex = -1
  node.focus({ preventScroll: true })
  node.dataset.located = 'true'
  window.setTimeout(() => delete node.dataset.located, 1600)
  return true
}
export function BoundSurface({
  binding,
  client,
  id,
  placement,
  inAnswer,
  workbenchOpen,
  onDismiss,
  onRestore,
  onLocate,
  onClose,
}: {
  binding: UiPlacementBinding
  client: IntelligentUiClient
  id: string
  placement: 'inline' | 'workbench'
  inAnswer?: boolean
  workbenchOpen?: boolean
  onDismiss?: () => void
  onRestore?: () => void
  onLocate?: () => void
  onClose?: () => void
}) {
  // A closed view inside an answer is read back by id; it stays in place, read-only.
  const record = client.knownRecord(id)!
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
        <RegisteredConversationCard
          card={{ kind: 'artifact-file', data: { file, sessionId: client.sessionId, laneId: record.lane } }}
          context={{ t: (key) => key, resources: binding.resources }}
        />
      )}
      {...(binding.customModules ? { renderCustom } : {})}
      record={record}
      placement={placement}
      inAnswer={inAnswer}
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
      onRestore={onRestore}
      onLocate={onLocate}
      onClose={onClose}
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
    // Only a workbench-only view opens the workbench; anything shown in the answer waits to be asked.
    if (record.surface.placement.workbench && !record.surface.placement.inline) showWorkbench = true
  }
  return { keys, showConversation, showWorkbench }
}
