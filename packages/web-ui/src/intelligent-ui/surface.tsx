import type {
  JsonValue,
  UiAction,
  UiActionReceipt,
  UiRowContext,
  UiSourceStatus,
  UiSurfaceRecord,
} from '@agnes/protocol/gen/intelligent-ui'
import { type ReactNode, useId, useState } from 'react'
import { SettingsState, SettingsToolbar } from '../settings-layout.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { IconButton } from '../ui/icon-button.js'
import { Menu } from '../ui/menu.js'
import { MetaText } from '../ui/tag.js'
import { Toast } from '../ui/toast.js'
import { useUiText } from '../ui-locale.js'
import { IntelligentCatalog, type IntelligentCatalogProps } from './catalog.js'
import { IntelligentSurfaceChip } from './chip.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import { SurfaceRenderBoundary } from './render-boundary.js'
import { docksInConversation, surfaceTitle } from './summary.js'

export interface IntelligentSurfaceProps {
  renderArtifact?: IntelligentCatalogProps['renderArtifact']
  renderCustom?: IntelligentCatalogProps['renderCustom']
  record: UiSurfaceRecord
  placement: 'inline' | 'workbench'
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
  /** Offered on the docked chip only: take it out of the conversation, keep it in the workbench. */
  onDismiss?: (() => void) | undefined
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
      setCopyMessage(t('ui.copied'))
    } catch {
      setCopyFailed(true)
      setCopyMessage(t('ui.copyFailed'))
    }
  }
  return (
    <article
      className="agnes-intelligent-surface"
      data-testid={`ui-surface-${surface.id}`}
      data-placement={props.placement}
      data-revision={surface.revision}
      aria-labelledby={titleId}
    >
      <Toast
        tone={copyFailed ? 'error' : 'success'}
        open={!!copyMessage}
        onDismiss={() => setCopyMessage('')}
      >
        {copyMessage}
      </Toast>
      <header>
        <h3 id={titleId} title={t('ui.revision', { revision: surface.revision })}>
          {surfaceTitle(surface, t)}
        </h3>
        {record.status === 'closed' && <MetaText>{t('ui.closed')}</MetaText>}
        <Menu
          label={t('ui.menu')}
          trigger={<IconButton name="ellipsis" label={t('ui.menu')} />}
          items={[
            { id: 'source', label: t('ui.source'), onSelect: () => setSourceVisible((value) => !value) },
            {
              id: 'copy',
              label: t('ui.copy'),
              onSelect: () => void copySummary(),
            },
          ]}
        />
        {props.placement === 'inline' && surface.placement.workbench && (
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
      </header>
      <p hidden={record.owner === 'agnes/intelligent-ui'} className="agnes-intelligent-attribution">
        {t('ui.from', { owner: record.owner })}
      </p>
      {sourceVisible && (
        <details open>
          <summary>{t('ui.source')}</summary>
          <dl>
            <dt>{t('ui.owner')}</dt>
            <dd>{record.owner}</dd>
            <dt>{t('ui.revision', { revision: surface.revision })}</dt>
            <dd>{surface.id}</dd>
          </dl>
        </details>
      )}
      <>
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
        <div className="agnes-intelligent-body">
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
        <ol data-testid="ui-receipts" aria-live="polite" aria-relevant="additions text">
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
      </>
    </article>
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
      {receipt.summary && <p>{receipt.summary}</p>}
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
