import { validateMethod } from '@agnes/protocol'
import type { AdminFeedbackParams, AdminFeedbackResult } from '@agnes/protocol/gen/app-server'

/** A refused feedback request; `reason` is the server's rejection code when it sent one. */
export class FeedbackRequestError extends Error {
  constructor(readonly reason: string | undefined) {
    super('Feedback unavailable')
  }
}
const rejectionReason = (value: unknown): string | undefined => {
  const reason = (value as { error?: { data?: { reason?: unknown } } } | null)?.error?.data?.reason
  return typeof reason === 'string' ? reason : undefined
}

export async function feedbackRequest(
  input: AdminFeedbackParams,
  signal?: AbortSignal,
): Promise<AdminFeedbackResult> {
  const response = await fetch('/api/feedback', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  const value: unknown = await response.json()
  if (!response.ok || !validateMethod('_agnes/v1/admin.feedback', 'result', value).ok)
    throw new FeedbackRequestError(rejectionReason(value))
  if (input.action !== 'list' && input.sessionId) invalidateSessionFeedback(input.sessionId)
  return value as AdminFeedbackResult
}

type SessionFeedbackLoad = {
  listeners: Set<() => void>
  pending?: Promise<AdminFeedbackResult>
  abort?: AbortController
}
const sessions = new Map<string, SessionFeedbackLoad>()
const sessionLoad = (sessionId: string): SessionFeedbackLoad => {
  let load = sessions.get(sessionId)
  if (!load) {
    load = { listeners: new Set() }
    sessions.set(sessionId, load)
  }
  return load
}

/** Consumers own subscriptions; unmounting one message never aborts another message's load. */
export function subscribeSessionFeedback(sessionId: string, listener: () => void): () => void {
  const load = sessionLoad(sessionId)
  load.listeners.add(listener)
  return () => {
    load.listeners.delete(listener)
    if (!load.listeners.size && sessions.get(sessionId) === load) {
      sessions.delete(sessionId)
      load.abort?.abort()
    }
  }
}

export function loadSessionFeedback(sessionId: string): Promise<AdminFeedbackResult> {
  const load = sessionLoad(sessionId)
  if (load.pending) return load.pending
  const abort = new AbortController()
  load.abort = abort
  const current = () => {
    if (sessions.get(sessionId) !== load) throw new Error('Feedback load disposed')
    return load.pending === pending
  }
  const pending: Promise<AdminFeedbackResult> = feedbackRequest(
    { action: 'list', sessionId },
    abort.signal,
  ).then(
    (value) => (current() ? value : loadSessionFeedback(sessionId)),
    (error: unknown) => {
      if (!current()) return loadSessionFeedback(sessionId)
      delete load.pending
      throw error
    },
  )
  load.pending = pending
  return pending
}

/** Drop old results before notifying so every subscriber joins the same fresh request. */
export function invalidateSessionFeedback(sessionId: string): void {
  const load = sessions.get(sessionId)
  if (!load) return
  delete load.pending
  load.abort?.abort()
  for (const listener of load.listeners) listener()
}
