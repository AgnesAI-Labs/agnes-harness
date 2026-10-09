import type {
  JsonValue,
  UiAction,
  UiActionReceipt,
  UiRowContext,
  UiSurfaceRecord,
} from '@agnes/protocol/gen/intelligent-ui'
import { type ReactNode, useId } from 'react'
import { Button } from '../ui/button.js'
import { useUiText } from '../ui-locale.js'
import { IntelligentCatalog, type IntelligentCatalogProps } from './catalog.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'

export interface IntelligentSurfaceProps {
  renderCustom?: IntelligentCatalogProps['renderCustom']
  record: UiSurfaceRecord
  placement: 'inline' | 'workbench'
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
  onConfirm(): void
  onCancel(): void
  onRetry(receipt: UiActionReceipt): void
  onReview(): void
  onRecover(): void
  onExpand(): void
  onApproval(receipt: UiActionReceipt): void
  onEvidence?(seq: number): void
}

export function IntelligentSurface(props: IntelligentSurfaceProps) {
  const { record, receipts } = props
  const { surface } = record
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const titleId = useId()
  return (
    <article
      className="agnes-intelligent-surface"
      data-testid={`ui-surface-${surface.id}`}
      data-placement={props.placement}
      data-revision={surface.revision}
      aria-labelledby={titleId}
    >
      <header>
        <h3 id={titleId}>{surface.title}</h3>
        <span>{t('ui.revision', { revision: surface.revision })}</span>
        <span>{t(`ui.${record.status}`)}</span>
        {props.placement === 'inline' && (
          <Button htmlType="button" data-testid="ui-expand" onClick={props.onExpand}>
            {t('ui.expand')}
          </Button>
        )}
      </header>
      <div role="status" aria-live="polite" aria-atomic="true">
        {props.draftChanged && <p data-testid="ui-draft-changed">{t('ui.draftChanged')}</p>}
        {props.needsReview && <p data-testid="ui-reconfirm-message">{t('ui.changed')}</p>}
        {props.error && <p>{t(props.error)}</p>}
        {props.invalid && <p>{t('ui.invalidJson')}</p>}
      </div>
      {props.needsReview && (
        <Button htmlType="button" data-testid="ui-review-current" onClick={props.onReview}>
          {t('ui.reconfirm')}
        </Button>
      )}
      <IntelligentCatalog
        {...(props.renderCustom ? { renderCustom: props.renderCustom } : {})}
        surface={surface}
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
      {props.confirmation && (
        <section role="group" aria-label={t('ui.confirm')} data-testid="ui-confirmation">
          <p>{props.confirmation.action.confirm ?? props.confirmation.action.label}</p>
          <p>{t('ui.approvalHelp')}</p>
          <Button
            htmlType="button"
            data-testid="ui-confirm"
            disabled={props.locked || props.invalid || props.confirmation.revision !== surface.revision}
            onClick={props.onConfirm}
          >
            {t('ui.confirm')}
          </Button>
          <Button htmlType="button" data-testid="ui-confirm-cancel" onClick={props.onCancel}>
            {t('ui.cancel')}
          </Button>
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
                  #{receipt.seq}
                </Button>
              ) : (
                <span>#{receipt.seq}</span>
              )
            }
          />
        ))}
      </ol>
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
      <strong>{t(`ui.${receipt.status}`)}</strong> {evidence}
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
