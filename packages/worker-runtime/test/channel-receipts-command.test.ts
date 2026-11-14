import type { Host } from '@agnes/host'
import { expect, it, vi } from 'vitest'
import type { WorkerCommandFrame } from '../src/frames.js'
import { isProfileCommand, profileServiceCommand } from '../src/profile-commands.js'

const frame = (params: Record<string, unknown>): WorkerCommandFrame => ({
  kind: 'command',
  requestId: 'r1',
  method: 'channels.receipts',
  params,
})

it("dispatches channels.receipts to the Host's parked-receipt decisions, and refuses without them", async () => {
  const params = { op: 'parked', owner: '@sample/desk#plugin/bb' }
  const channelReceipts = vi.fn(() => ({ receipts: [] }))
  expect(isProfileCommand('channels.receipts')).toBe(true)
  await expect(
    profileServiceCommand({ channelReceipts } as unknown as Host, frame(params), new Map()),
  ).resolves.toEqual({
    receipts: [],
  })
  expect(channelReceipts).toHaveBeenCalledWith(params)
  await expect(profileServiceCommand({} as Host, frame(params), new Map())).rejects.toMatchObject({
    data: { code: 'CAPABILITY_DENIED' },
  })
})
