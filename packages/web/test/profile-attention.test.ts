/** @vitest-environment happy-dom */
import type { HostAgnesClient } from '@agnes/web-client'
import { expect, it, vi } from 'vitest'
import { waitingAutomation } from '../src/regions/profile-attention.js'

it.each([200, 503])('reads trigger attention through the owner BFF (%s)', async (status) => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json(
      {
        snapshot: {
          rules: [{ id: 'rule', event: 'Issue opened' }],
          deliveries: [{ sessionId: 'run', ruleId: 'rule', status: 'waiting_approval' }],
        },
      },
      { status },
    ),
  )
  const call = vi.fn(async () => ({ schedules: [] }))
  try {
    expect(await waitingAutomation({ call } as unknown as HostAgnesClient)).toEqual(
      status === 200 ? [{ sessionId: 'run', title: 'Issue opened', source: 'trigger', waiting: true }] : [],
    )
    expect(call.mock.calls).toEqual([['_agnes/v1/schedules.list', { scope: 'all', includeArchived: true }]])
    expect(fetcher).toHaveBeenCalledWith(
      '/api/triggers',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'list' }),
      }),
    )
  } finally {
    fetcher.mockRestore()
  }
})
