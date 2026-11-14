import { describe, expect, it, vi } from 'vitest'
import { profileSessionProducer } from '../src/profile-session-producer.js'
import type { SharedSessionChannel } from '../src/shared-session-channel.js'

const caller = {
  owner: 'plugin/0123456789abcdef',
  packageId: 'companion',
  integrity: 'sha256-x',
  service: 'engine',
}
const input = {
  key: 'owner-input-1',
  target: { taskId: 't1', taskGeneration: 2, startKey: 'start-1' },
  input: { kind: 'ownerMessage', receiptId: 'r'.repeat(64) },
} as const

function producer() {
  const request = vi.fn(async (..._args: unknown[]) => ({ state: 'enqueued' }))
  const channel = {
    run: (_lane: string, work: () => Promise<unknown>) => work(),
    request,
  } as unknown as SharedSessionChannel
  return { sessions: profileSessionProducer(channel)(caller), request }
}

describe('profile session producer', () => {
  it('admitInput forwards caller, action and args only', async () => {
    const { sessions, request } = producer()
    await sessions.admitInput('s1', input)
    expect(request).toHaveBeenCalledTimes(1)
    const [method, params] = request.mock.calls[0] as [string, Record<string, unknown>]
    expect(method).toBe('managed-session')
    expect(params).toEqual({ ...caller, action: 'admitInput', args: ['s1', input] })
    expect(Object.keys(params).sort()).toEqual([
      'action',
      'args',
      'integrity',
      'owner',
      'packageId',
      'service',
    ])
  })

  it('inputResult forwards caller, action and args only', async () => {
    const { sessions, request } = producer()
    await sessions.inputResult('s1', { key: 'owner-input-1' })
    expect(request.mock.calls[0]?.[1]).toEqual({
      ...caller,
      action: 'inputResult',
      args: ['s1', { key: 'owner-input-1' }],
    })
  })

  it('admitResolved sends resolution beside args, never inside them', async () => {
    const { sessions, request } = producer()
    const resolution = {
      kind: 'receipt',
      receiptId: 'r'.repeat(64),
      text: 'hello',
      contentDigest: 'd'.repeat(64),
      source: {
        instanceId: 'i',
        pairingId: 'p',
        eventId: 'e',
        messageId: 'm',
        kind: 'message',
        at: '2026-11-14T00:00:00Z',
      },
    } as const
    await sessions.admitResolved('s1', input, resolution)
    const params = request.mock.calls[0]?.[1] as { action: string; args: unknown[]; resolution: unknown }
    expect(params).toEqual({ ...caller, action: 'admitInput', args: ['s1', input], resolution })
    expect(JSON.stringify(params.args)).not.toContain('hello')
  })
})
