import { validateMethod } from '@agnes/protocol'
import type { AdminFeedbackParams, AdminFeedbackResult } from '@agnes/protocol/gen/app-server'

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
    throw new Error('Feedback unavailable')
  return value as AdminFeedbackResult
}
