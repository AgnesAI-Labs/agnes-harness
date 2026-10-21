import { workbenchPanels } from '@agnes/web-client'
import type { WorkbenchContext } from '@agnes/web-conversation/workbench'
import { Button, EmptyState, Icon, useDocumentLanguage } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'
import { workbenchApproval } from './approval-store.js'

/** Mirrors the sole conversation decision. It never creates or answers a decision. */
export function ApprovalMirror({ signatures = false }: { signatures?: boolean }) {
  const view = useSyncExternalStore(workbenchApproval.subscribe, workbenchApproval.getSnapshot)
  const zh = useDocumentLanguage() === 'zh-CN'
  return view ? (
    <section className="application-panel">
      <h3>{view.summary}</h3>
      <p role="status">
        {view.kind === 'answered'
          ? zh
            ? '已确认，等待继续'
            : 'Answered; waiting to continue'
          : zh
            ? '等待在会话中确认'
            : 'Awaiting confirmation in conversation'}
      </p>
      <Button
        onClick={() => {
          const card = document.querySelector<HTMLElement>('#approval-content [data-approval-key]')
          card?.scrollIntoView?.({ block: 'nearest' })
          ;(card?.querySelector<HTMLButtonElement>('[data-approval-action]:not(:disabled)') ?? card)?.focus()
        }}
      >
        {zh ? '前往会话确认' : 'Go to confirmation'}
      </Button>
    </section>
  ) : (
    <EmptyState
      icon={<Icon name="check" />}
      title={
        signatures
          ? zh
            ? '当前没有待签署事项'
            : 'No signatures pending'
          : zh
            ? '当前没有待审批事项'
            : 'No approvals pending'
      }
      description={
        zh
          ? '当前会话需要确认时，将在这里显示宿主请求。'
          : 'Host requests appear here when this session needs confirmation.'
      }
    />
  )
}

export function registerSessionApprovalPanel(): () => void {
  return workbenchPanels.register({
    id: 'approvals',
    order: 90,
    edge: 'right',
    titleKey: 'workbench.approvals.title',
    visibility: 'contextual',
    icon: 'check',
    when: (context) =>
      Boolean((context.data as WorkbenchContext | undefined)?.session?.id && workbenchApproval.getSnapshot()),
    count: {
      subscribe: workbenchApproval.subscribe,
      read: () => (workbenchApproval.getSnapshot() ? 1 : undefined),
    },
    component: () => <ApprovalMirror />,
  })
}
