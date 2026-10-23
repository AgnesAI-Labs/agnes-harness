import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Toast } from './overlay-toast.js'
import { Banner } from './ui/banner.js'
import { Button } from './ui/button.js'

export type FeedbackAction = { label: string; onSelect(): void; busy?: boolean }
export type OperationFeedback = {
  id: string
  scope: string
  outcome: 'success' | 'error' | 'pending' | 'unknown' | 'partial'
  message: string
  /** Scope is part of the toast; action consequences remain until the owner resolves them. */
  effect?:
    | { kind: 'current-session' | 'next-request' | 'new-sessions'; message: string }
    | {
        kind: 'restart-required' | 'rescan-required' | 'reconnect-required' | 'enable-required'
        message: string
        action?: FeedbackAction
      }
}
export type FeedbackSink = {
  publish(result: OperationFeedback): void
  resolve(scope: string): void
}
let sink: FeedbackSink | undefined
let sequence = 0
/** The application shell installs its sink; presentation never calls business services. */
export function installFeedbackSink(next: FeedbackSink): () => void {
  const previous = sink
  sink = next
  return () => {
    if (sink === next) sink = previous
  }
}
export function publishFeedback(result: OperationFeedback): void {
  sink?.publish(result)
}
export function resolveFeedback(scope: string): void {
  sink?.resolve(scope)
}
export function reportSuccess(scope: string, message: string, effect?: OperationFeedback['effect']): void {
  publishFeedback({
    id: `${scope}:${++sequence}`,
    scope,
    outcome: 'success',
    message,
    ...(effect ? { effect } : {}),
  })
}
export type FeedbackSnapshot = {
  queue: readonly OperationFeedback[]
  notices: readonly OperationFeedback[]
}
export const emptyFeedback: FeedbackSnapshot = { queue: [], notices: [] }
export function actionable(result: OperationFeedback): boolean {
  return (
    !!result.effect &&
    ['restart-required', 'rescan-required', 'reconnect-required', 'enable-required'].includes(
      result.effect.kind,
    )
  )
}
/** Pure queue policy. The shell retains the operation-id set across route changes. */
export function enqueueFeedback(snapshot: FeedbackSnapshot, result: OperationFeedback): FeedbackSnapshot {
  if (result.outcome !== 'success') return snapshot
  return {
    /* Repeating one control replaces what is still waiting for it instead of queuing behind it:
       three quick model switches would otherwise show three seconds of stale copy each. */
    queue: [...snapshot.queue.filter((item) => item.scope !== result.scope), result],
    notices: actionable(result)
      ? [...snapshot.notices.filter((item) => item.scope !== result.scope), result]
      : snapshot.notices,
  }
}
export function StatusMessage({
  kind,
  children,
  action,
  ...props
}: {
  kind: 'error' | 'notice' | 'pending' | 'partial'
  children: ReactNode
  action?: FeedbackAction | undefined
  'data-testid'?: string
}) {
  return (
    <Banner
      {...props}
      tone={kind === 'error' ? 'error' : kind === 'notice' || kind === 'partial' ? 'warning' : 'info'}
      action={
        action && (
          <Button loading={!!action.busy} onClick={action.onSelect}>
            {action.label}
          </Button>
        )
      }
    >
      {children}
    </Banner>
  )
}
export function FeedbackHost({
  snapshot,
  onDismiss,
  noticeContainer,
}: {
  noticeContainer?: Element | null | undefined
  snapshot: FeedbackSnapshot
  onDismiss(id: string): void
}) {
  const current = snapshot.queue[0]
  const notices = snapshot.notices.map((result) => (
    <StatusMessage
      key={result.scope}
      kind="notice"
      data-testid="operation-notice"
      action={result.effect && 'action' in result.effect ? result.effect.action : undefined}
    >
      {result.effect?.message}
    </StatusMessage>
  ))
  return (
    <>
      {current && (
        <Toast
          key={current.id}
          open
          duration={3000}
          onDismiss={() => onDismiss(current.id)}
          data-testid="operation-toast"
        >
          {current.message}
          {current.effect && !actionable(current) ? ` ${current.effect.message}` : ''}
        </Toast>
      )}
      {notices.length > 0 &&
        (noticeContainer ? (
          createPortal(<div className="agh-feedback-notices">{notices}</div>, noticeContainer)
        ) : (
          <div className="agh-feedback-notices">{notices}</div>
        ))}
    </>
  )
}
