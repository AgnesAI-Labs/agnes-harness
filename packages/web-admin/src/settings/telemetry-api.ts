import { validateMethod } from '@agnes/protocol'
import type { AdminTelemetryParams, AdminTelemetryResult } from '@agnes/protocol/gen/app-server'

export async function telemetryRequest(
  input: AdminTelemetryParams = {},
  signal?: AbortSignal,
): Promise<AdminTelemetryResult> {
  if (!validateMethod('_agnes/v1/admin.telemetry', 'params', input).ok)
    throw new Error('Telemetry settings unavailable')
  const response = await fetch('/api/telemetry', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  const value: unknown = await response.json()
  if (!response.ok || !validateMethod('_agnes/v1/admin.telemetry', 'result', value).ok)
    throw new Error('Telemetry settings unavailable')
  return value as AdminTelemetryResult
}
