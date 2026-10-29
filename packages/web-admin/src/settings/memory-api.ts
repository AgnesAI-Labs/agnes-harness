import { validateMethod } from '@agnes/protocol'
import type { AdminMemoryParams, AdminMemoryResult } from '@agnes/protocol/gen/app-server'

/** HTTP only adapts the generated admin operation; settings and file ownership remain in Host. */
export async function memoryRequest(
  input: AdminMemoryParams,
  signal?: AbortSignal,
): Promise<AdminMemoryResult> {
  const response = await fetch('/api/memory', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  const value: unknown = await response.json()
  if (!response.ok)
    throw Object.assign(new Error('memory unavailable'), { envelope: (value as { error?: unknown })?.error })
  if (!validateMethod('_agnes/v1/admin.memory', 'result', value).ok)
    throw new Error('invalid memory response')
  return value as AdminMemoryResult
}
