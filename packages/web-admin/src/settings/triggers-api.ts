import type { WebhookRequest, WebhookResult } from '@agnes/protocol/gen/app-server'

export async function triggersRequest(input: WebhookRequest, signal?: AbortSignal): Promise<WebhookResult> {
  const response = await fetch('/api/triggers', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) throw new Error('Trigger request failed')
  return response.json()
}
