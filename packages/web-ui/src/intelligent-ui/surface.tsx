import type {
  JsonValue,
  UiAction,
  UiActionReceipt,
  UiRowContext,
  UiSourceStatus,
  UiSurface,
  UiSurfaceRecord,
} from '@agnes/protocol/gen/intelligent-ui'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { reportSuccess, StatusMessage } from '../feedback.js'
import { SettingsState, SettingsToolbar } from '../settings-layout.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { CopyButton } from '../ui/copy-button.js'
import { Disclosure } from '../ui/disclosure.js'
import { Icon } from '../ui/icon.js'
import { IconButton } from '../ui/icon-button.js'
import { Menu, type MenuItem } from '../ui/menu.js'
import { MetaText } from '../ui/tag.js'
import { useUiText } from '../ui-locale.js'
import { IntelligentActionButtons, IntelligentCatalog, type IntelligentCatalogProps } from './catalog.js'
import { IntelligentSurfaceChip } from './chip.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import { SurfaceRenderBoundary } from './render-boundary.js'
import { degradedDataKeys } from './source-state.js'
import { docksInConversation, isDeliverableList, surfaceIcon, surfaceTitle } from './summary.js'

export interface IntelligentSurfaceProps {
  renderArtifact?: IntelligentCatalogProps['renderArtifact']
  renderCustom?: IntelligentCatalogProps['renderCustom']
  record: UiSurfaceRecord
  placement: 'inline' | 'workbench'
  /** Shown inside the answer that produced it: a compact header and a capped body for large views. */
  inAnswer?: boolean | undefined
  workbenchOpen?: boolean | undefined
  input: Record<string, JsonValue>
  selection: Record<string, string[]>
  receipts: readonly UiActionReceipt[]
  locked: boolean
  invalid: boolean
  needsReview: boolean
  draftChanged: boolean
  confirmation?: { action: UiAction; revision: number }
  transportPending: boolean
  error?: string
  onInput: IntelligentCatalogProps['onInput']
  onSelection: IntelligentCatalogProps['onSelection']
  onInvalid: IntelligentCatalogProps['onInvalid']
  onAction(action: UiAction, row?: UiRowContext): void
  onRefreshSource?(): void
  onConfirm(): void
  onCancel(): void
  onRetry(receipt: UiActionReceipt): void
  onReview(): void
  onRecover(): void
  onExpand(): void
  /** Take a docked surface out of the conversation; it stays in the workbench. */
  onDismiss?: (() => void) | undefined
  /** Show a surface hidden from the conversation there again. */
  onRestore?: (() => void) | undefined
  /** Scroll the conversation to this surface's card or chip. */
  onLocate?: (() => void) | undefined
  /** Close the panel in the workbench list; presentation only, the surface itself stays open. */
  onClose?: (() => void) | undefined
  onApproval(receipt: UiActionReceipt): void
  onEvidence?(seq: number): void
}

export function IntelligentSurface(props: IntelligentSurfaceProps) {
  if (props.placement === 'inline' && docksInConversation(props.record.surface))
    return (
      <IntelligentSurfaceChip
        record={props.record}
        workbenchOpen={props.workbenchOpen}
        locked={props.locked}
        needsReview={props.needsReview}
        pendingApproval={props.receipts.some((receipt) => receipt.status === 'pending-approval')}
        onExpand={props.onExpand}
        onDismiss={props.onDismiss}
      />
    )
  return <SurfaceCard {...props} />
}
function SurfaceCard(props: IntelligentSurfaceProps) {
  const { record, receipts } = props
  const { surface } = record
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const titleId = useId()
  const [sourceVisible, setSourceVisible] = useState(false)
  const [copyMessage, setCopyMessage] = useState('')
  const [copyFailed, setCopyFailed] = useState(false)
  const [full, setFull] = useState(false)
  const capped = !!props.inAnswer && !full && isLarge(surface)
  // «Show all» only when the capped view really hides something.
  const body = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  useEffect(() => {
    const node = body.current
    if (!node || !props.inAnswer || !isLarge(surface)) return
    const measure = () => setOverflows(node.scrollHeight > node.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [props.inAnswer, surface])
  const openInWorkbench = props.placement === 'inline' && surface.placement.workbench
  const deliverables = isDeliverableList(surface)
  const textComponent = surface.components.find((component) => component.kind === 'text')
  const text = textComponent && 'dataKey' in textComponent ? surface.data[textComponent.dataKey] : undefined
  const summary =
    surface.summary ??
    (typeof text === 'string' ? text.slice(0, 240) : undefined) ??
    (props.needsReview
      ? t('ui.changed')
      : receipts.some((receipt) => receipt.status === 'pending-approval')
        ? t('ui.pending-approval')
        : t('ui.summary', { count: record.status === 'open' && !props.locked ? surface.actions.length : 0 }))
  const copySummary = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(summary)
      setCopyFailed(false)
      setCopyMessage('')
      reportSuccess('clipboard', t('ui.copied'))
    } catch {
      setCopyFailed(true)
      setCopyMessage(t('ui.copyFailed'))
    }
  }
  // A file list keeps its own row actions; every other surface gets the panel frame's action bar.
  const bar = deliverables ? undefined : footerActionGroup(surface)
  const liftedId = bar?.componentId
  const lifted = useMemo(() => new Set(liftedId ? [liftedId] : []), [liftedId])
  const latest = latestReceipt(receipts)
  const showMore = !!props.inAnswer && isLarge(surface) && (overflows || full)
  const showWorkbenchLink = !!props.inAnswer && openInWorkbench && isLarge(surface)
  const menu: MenuItem[] = [
    ...(props.inAnswer && openInWorkbench
      ? [{ id: 'workbench', label: t('ui.file.inWorkbench'), testId: 'ui-expand', onSelect: props.onExpand }]
      : []),
    ...(props.onLocate
      ? [{ id: 'locate', label: t('ui.locate'), testId: 'ui-locate', onSelect: props.onLocate }]
      : []),
    ...(props.onDismiss
      ? [{ id: 'dismiss', label: t('ui.dock.dismiss'), testId: 'ui-dismiss', onSelect: props.onDismiss }]
      : props.onRestore
        ? [{ id: 'restore', label: t('ui.dock.restore'), testId: 'ui-restore', onSelect: props.onRestore }]
        : []),
    ...(props.onClose
      ? [{ id: 'close', label: t('ui.close'), testId: 'ui-close', onSelect: props.onClose }]
      : []),
    { id: 'source', label: t('ui.source'), onSelect: () => setSourceVisible((value) => !value) },
    { id: 'copy', label: t('ui.copy'), onSelect: () => void copySummary() },
  ]
  return (
    <article
      className="agnes-intelligent-surface"
      data-testid={`ui-surface-${surface.id}`}
      data-placement={props.placement}
      {...(props.inAnswer ? { 'data-in-answer': true } : {})}
      // A surface that only hands over files is a file list, not a form: it drops the card chrome.
      {...(deliverables ? { 'data-kind': 'deliverables' } : {})}
      data-revision={surface.revision}
      aria-labelledby={titleId}
    >
      {copyFailed && (
        <StatusMessage kind="error" action={{ label: t('ui.copy'), onSelect: () => void copySummary() }}>
          {copyMessage}
        </StatusMessage>
      )}
      <header>
        {!deliverables && (
          <span className="agnes-intelligent-icon" aria-hidden="true">
            <Icon name={surfaceIcon(surface)} />
          </span>
        )}
        <div className="agnes-intelligent-heading">
          <h3 id={titleId} title={t('ui.revision', { revision: surface.revision })}>
            {surfaceTitle(surface, t)}
          </h3>
          {!deliverables && (
            <p className="agnes-intelligent-meta" data-testid="ui-meta">
              {record.owner === 'agnes/intelligent-ui'
                ? t('ui.meta', { revision: surface.revision })
                : t('ui.meta.from', { owner: record.owner, revision: surface.revision })}
            </p>
          )}
        </div>
        {record.status === 'closed' && <MetaText>{t('ui.closed')}</MetaText>}
        {!props.inAnswer && openInWorkbench && (
          <Button
            htmlType="button"
            {...(props.workbenchOpen ? { appearance: 'ghost' as const } : {})}
            data-testid="ui-expand"
            aria-pressed={!!props.workbenchOpen}
            title={t(props.workbenchOpen ? 'ui.dock.focus' : 'ui.expand')}
            onClick={props.onExpand}
          >
            {t(props.workbenchOpen ? 'ui.dock.shown' : 'ui.expand')}
          </Button>
        )}
        <Menu
          label={t('ui.menu')}
          trigger={<IconButton name="ellipsis" label={t('ui.menu')} />}
          items={menu}
        />
      </header>
      {sourceVisible && (
        <Disclosure defaultOpen summary={t('ui.source')}>
          <dl className="agnes-intelligent-source-list" data-testid="ui-source">
            <dt>{t('ui.owner')}</dt>
            <dd>{record.owner}</dd>
            <dt>{t('ui.cardId')}</dt>
            {/* The full id stays in the DOM for screen readers and in the title; CSS truncates the row. */}
            <dd title={surface.id}>{surface.id}</dd>
          </dl>
        </Disclosure>
      )}
      <SettingsState
        hidden={!props.draftChanged && !props.needsReview && !props.error && !props.invalid}
        tone={props.error || props.invalid ? 'error' : 'empty'}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {props.draftChanged && <p data-testid="ui-draft-changed">{t('ui.draftChanged')}</p>}
        {props.needsReview && <p data-testid="ui-reconfirm-message">{t('ui.changed')}</p>}
        {props.error && <p>{t(props.error)}</p>}
        {props.invalid && <p>{t('ui.invalidJson')}</p>}
      </SettingsState>
      {props.needsReview && (
        <Button htmlType="button" data-testid="ui-review-current" onClick={props.onReview}>
          {t('ui.reconfirm')}
        </Button>
      )}
      <div
        ref={body}
        className="agnes-intelligent-body"
        data-capped={capped || undefined}
        data-overflows={(capped && overflows) || undefined}
      >
        <SurfaceRenderBoundary key={surface.revision} message={t('ui.renderError')} retry={t('ui.refresh')}>
          <IntelligentCatalog
            {...(props.renderArtifact ? { renderArtifact: props.renderArtifact } : {})}
            {...(props.renderCustom ? { renderCustom: props.renderCustom } : {})}
            surface={surface}
            {...(record.sources
              ? { sources: record.sources as Readonly<Record<string, UiSourceStatus>> }
              : {})}
            {...(props.onRefreshSource ? { onRefreshSource: props.onRefreshSource } : {})}
            instance={props.placement}
            input={props.input}
            selection={props.selection}
            disabled={props.locked}
            invalid={props.invalid}
            liftedIds={lifted}
            onInput={props.onInput}
            onSelection={props.onSelection}
            onInvalid={props.onInvalid}
            onAction={props.onAction}
          />
        </SurfaceRenderBoundary>
      </div>
      {props.confirmation && (
        <section role="group" aria-label={t('ui.confirm')} data-testid="ui-confirmation">
          <p>{props.confirmation.action.confirm ?? props.confirmation.action.label}</p>
          <p>{t('ui.approvalHelp')}</p>
          <SettingsToolbar>
            <Button htmlType="button" data-testid="ui-confirm-cancel" onClick={props.onCancel}>
              {t('ui.cancel')}
            </Button>
            <Button
              htmlType="button"
              appearance="primary"
              data-testid="ui-confirm"
              disabled={props.locked || props.invalid || props.confirmation.revision !== surface.revision}
              onClick={props.onConfirm}
            >
              {t('ui.confirm')}
            </Button>
          </SettingsToolbar>
        </section>
      )}
      {props.transportPending && (
        <Button htmlType="button" data-testid="ui-recover-command" onClick={props.onRecover}>
          {t('ui.resend')}
        </Button>
      )}
      <ol
        data-testid="ui-receipts"
        aria-live="polite"
        aria-relevant="additions text"
        hidden={!receipts.length}
      >
        {receipts.map((receipt) => (
          <Receipt
            key={receipt.commandId}
            receipt={receipt}
            locked={props.locked}
            onRetry={() => props.onRetry(receipt)}
            onApproval={() => props.onApproval(receipt)}
            evidence={
              props.onEvidence ? (
                <Button htmlType="button" onClick={() => props.onEvidence?.(receipt.seq)}>
                  {'#'}
                  {receipt.seq}
                </Button>
              ) : (
                <span>
                  {'#'}
                  {receipt.seq}
                </span>
              )
            }
          />
        ))}
      </ol>
      {(latest || bar || showMore || showWorkbenchLink) && (
        <footer className="agnes-intelligent-footer" data-testid="ui-footer">
          {latest ? <ActionState receipt={latest} onApproval={() => props.onApproval(latest)} /> : <span />}
          <div className="agnes-intelligent-footer-actions">
            {showMore && (
              <Button
                htmlType="button"
                appearance="ghost"
                size="small"
                className="agnes-intelligent-more"
                data-testid="ui-card-more"
                aria-expanded={full}
                onClick={() => setFull((value) => !value)}
              >
                {t(full ? 'ui.card.less' : 'ui.card.more')}
              </Button>
            )}
            {showWorkbenchLink && (
              <Button
                htmlType="button"
                appearance="ghost"
                size="small"
                data-testid="ui-card-workbench"
                onClick={props.onExpand}
              >
                {t('ui.file.inWorkbench')}
              </Button>
            )}
            {bar && (
              <IntelligentActionButtons
                surface={surface}
                actionIds={bar.actionIds}
                degradedKeys={degradedDataKeys(surface, record.sources)}
                disabled={props.locked || props.invalid}
                onAction={(action) => props.onAction(action)}
              />
            )}
          </div>
        </footer>
      )}
    </article>
  )
}
/**
 * A trailing button group, with at most status lines after it, is the surface's action bar: the
 * frame shows it in its footer, secondary actions first and the primary one last.
 */
export function footerActionGroup(
  surface: Pick<UiSurface, 'components' | 'actions'>,
): { componentId: string; actionIds: string[] } | undefined {
  const { components } = surface
  for (let index = components.length - 1; index >= 0; index--) {
    const component = components[index]!
    if ('fallback' in component) return undefined
    if (component.kind === 'status') continue
    if (component.kind !== 'button-group' || component.title) return undefined
    const nested = components.some(
      (other) =>
        !('fallback' in other) &&
        other.kind === 'tabs' &&
        other.tabs.some((tab) => tab.componentIds.includes(component.id)),
    )
    if (nested) return undefined
    const primary = (id: string) =>
      surface.actions.find((action) => action.id === id)?.style === 'primary' ? 1 : 0
    return {
      componentId: component.id,
      actionIds: [...component.actionIds].sort((a, b) => primary(a) - primary(b)),
    }
  }
  return undefined
}
/** The most recent action record: its state is the one the footer reports. */
export function latestReceipt(receipts: readonly UiActionReceipt[]): UiActionReceipt | undefined {
  return receipts.reduce<UiActionReceipt | undefined>(
    (latest, receipt) => (!latest || receipt.seq >= latest.seq ? receipt : latest),
    undefined,
  )
}
const RUN_TONE: Record<UiActionReceipt['status'], string> = {
  received: 'info',
  executing: 'info',
  'pending-approval': 'warning',
  succeeded: 'success',
  failed: 'error',
  rejected: 'error',
}
/** Received → running → waiting for permission → succeeded / failed / refused → delivered to the Agent. */
function ActionState({ receipt, onApproval }: { receipt: UiActionReceipt; onApproval(): void }) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const finished = ['succeeded', 'failed', 'rejected'].includes(receipt.status)
  return (
    <p
      className="agnes-intelligent-run"
      data-testid="ui-action-state"
      data-state={receipt.status}
      role="status"
      aria-live="polite"
    >
      <span className="agnes-intelligent-tag" data-tone={RUN_TONE[receipt.status]}>
        {t(`ui.run.${receipt.status}`)}
      </span>
      {receipt.status === 'pending-approval' && (
        <Button
          htmlType="button"
          appearance="link"
          size="small"
          data-testid="ui-locate-approval"
          onClick={onApproval}
        >
          {t('ui.run.locate')}
        </Button>
      )}
      {finished && (
        <span className="agnes-intelligent-run-note" data-testid="ui-action-delivered">
          {t('ui.run.delivered')}
        </span>
      )}
    </p>
  )
}
/** Wide or tall views are capped inside an answer; the workbench and «show all» give the full view. */
function isLarge(surface: UiSurface): boolean {
  return (
    surface.components.length > 3 ||
    surface.components.some(
      (component) => 'fallback' in component || ['table', 'chart', 'tabs'].includes(component.kind),
    )
  )
}
/** A receipt that carries structured data is shown as source, not as a paragraph of JSON. */
export function ReceiptSummary({ text }: { text: string }) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const formatted = useMemo(() => {
    const trimmed = text.trim()
    if (!/^[[{]/.test(trimmed)) return undefined
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return undefined
    }
  }, [text])
  if (formatted === undefined) return <p>{text}</p>
  return (
    <figure className="agnes-intelligent-code" data-testid="ui-receipt-data">
      <figcaption>
        <span>{t('ui.receiptData')}</span>
        <CopyButton label={t('ui.copyData')} copiedLabel={t('ui.dataCopied')} text={formatted} />
      </figcaption>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the block scrolls on its own, so it must be reachable by keyboard. */}
      <pre tabIndex={0}>{formatted}</pre>
    </figure>
  )
}
function Receipt({
  receipt,
  locked,
  onRetry,
  onApproval,
  evidence,
}: {
  receipt: UiActionReceipt
  locked: boolean
  onRetry(): void
  onApproval(): void
  evidence: ReactNode
}) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const refusal = receipt.refusal
  const refusalKey =
    refusal?.reason === 'stale' || refusal?.reason === 'closed' ? 'ui.changed' : `ui.${refusal?.reason}`
  return (
    <li data-testid={`ui-receipt-${receipt.commandId}`} data-status={receipt.status}>
      <Badge
        tone={
          receipt.status === 'failed'
            ? 'bad'
            : receipt.status === 'succeeded'
              ? 'ok'
              : receipt.status === 'pending-approval'
                ? 'warn'
                : 'off'
        }
      >
        {t(`ui.${receipt.status}`)}
      </Badge>{' '}
      {evidence}
      {receipt.summary && <ReceiptSummary text={receipt.summary} />}
      {refusal && (
        <p>
          {t(refusalKey)} <span>{refusal.message}</span>
        </p>
      )}
      {receipt.failure && <p>{receipt.failure.outcomeUnknown ? t('ui.unknown') : receipt.failure.message}</p>}
      {receipt.status === 'pending-approval' && (
        <Button htmlType="button" data-testid="ui-open-approval" onClick={onApproval}>
          {t('ui.approval')}
        </Button>
      )}
      {receipt.status === 'failed' && receipt.failure?.retryable && !receipt.failure.outcomeUnknown && (
        <Button htmlType="button" data-testid="ui-retry" disabled={locked} onClick={onRetry}>
          {t('ui.retry')}
        </Button>
      )}
    </li>
  )
}
