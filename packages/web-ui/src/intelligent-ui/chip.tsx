import type { UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { useId, useState } from 'react'
import { reportSuccess, StatusMessage } from '../feedback.js'
import { Button } from '../ui/button.js'
import { Icon } from '../ui/icon.js'
import { IconButton } from '../ui/icon-button.js'
import { Menu, type MenuItem } from '../ui/menu.js'
import { MetaText } from '../ui/tag.js'
import { useUiText } from '../ui-locale.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'
import { surfaceDockSummary, surfaceIcon, surfaceTitle, useNow } from './summary.js'

export interface IntelligentSurfaceChipProps {
  record: UiSurfaceRecord
  /** The complete view is the one currently shown in the workbench. */
  workbenchOpen?: boolean | undefined
  locked: boolean
  needsReview: boolean
  pendingApproval: boolean
  onExpand(): void
  /** Remove the chip from the conversation; the surface stays in the workbench. */
  onDismiss?: (() => void) | undefined
}

/** The conversation's one-line pointer to a surface whose complete view lives in the workbench. */
export function IntelligentSurfaceChip(props: IntelligentSurfaceChipProps) {
  const { record } = props
  const { surface } = record
  const { t, locale } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const now = useNow()
  const titleId = useId()
  const [copyMessage, setCopyMessage] = useState('')
  const [copyFailed, setCopyFailed] = useState(false)
  const title = surfaceTitle(surface, t)
  const attention = props.needsReview
    ? t('ui.changed')
    : props.pendingApproval
      ? t('ui.pending-approval')
      : undefined
  const summary =
    attention ??
    surfaceDockSummary(surface, {
      t,
      locale,
      now,
      actionable: record.status === 'open' && !props.locked,
    })
  const copySummary = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(summary ? `${title} · ${summary}` : title)
      setCopyFailed(false)
      setCopyMessage('')
      reportSuccess('clipboard', t('ui.copied'))
    } catch {
      setCopyFailed(true)
      setCopyMessage(t('ui.copyFailed'))
    }
  }
  const items: MenuItem[] = [
    { id: 'expand', label: t('ui.expand'), onSelect: props.onExpand },
    { id: 'copy', label: t('ui.copy'), onSelect: () => void copySummary() },
    ...(props.onDismiss
      ? [{ id: 'dismiss', label: t('ui.dock.dismiss'), testId: 'ui-dismiss', onSelect: props.onDismiss }]
      : []),
  ]
  return (
    <article
      className="agnes-intelligent-chip"
      data-testid={`ui-surface-${surface.id}`}
      data-placement="inline"
      data-revision={surface.revision}
      data-active={props.workbenchOpen || undefined}
      data-attention={attention ? true : undefined}
      aria-labelledby={titleId}
    >
      {copyFailed && (
        <StatusMessage kind="error" action={{ label: t('ui.copy'), onSelect: () => void copySummary() }}>
          {copyMessage}
        </StatusMessage>
      )}
      <Button
        htmlType="button"
        appearance="ghost"
        className="agnes-intelligent-chip-main"
        data-testid="ui-expand"
        aria-pressed={!!props.workbenchOpen}
        title={t(props.workbenchOpen ? 'ui.dock.focus' : 'ui.expand')}
        onClick={props.onExpand}
      >
        <Icon name={surfaceIcon(surface)} />
        <span id={titleId} className="agnes-intelligent-chip-title">
          {title}
        </span>
        {summary && (
          <span className="agnes-intelligent-chip-summary" data-testid="ui-summary">
            {summary}
          </span>
        )}
        {record.status === 'closed' && <MetaText>{t('ui.closed')}</MetaText>}
        <span className="agnes-intelligent-chip-state">
          {props.workbenchOpen ? t('ui.dock.shown') : <Icon name="panel-right" />}
        </span>
      </Button>
      <Menu
        label={t('ui.menu')}
        trigger={<IconButton name="ellipsis" label={t('ui.menu')} />}
        items={items}
      />
    </article>
  )
}
