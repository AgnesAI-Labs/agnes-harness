import { validateMethod } from '@agnes/protocol'
import type { AdminObservabilityParams, AdminObservabilityResult } from '@agnes/protocol/gen/app-server'

export async function observabilityRequest(
  input: AdminObservabilityParams = {},
  signal?: AbortSignal,
): Promise<AdminObservabilityResult> {
  const response = await fetch('/api/observability', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  const value: unknown = await response.json()
  if (!response.ok || !validateMethod('_agnes/v1/admin.observability', 'result', value).ok)
    throw new Error('Exporter settings unavailable')
  return value as AdminObservabilityResult
}
