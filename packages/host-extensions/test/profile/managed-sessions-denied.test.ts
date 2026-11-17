import { describe, expect, it } from 'vitest'
import { deniedManagedSessions } from '../../src/profile/managed-sessions.js'

describe('denied managed sessions', () => {
  it('denied port refuses admitInput and inputResult with CAPABILITY_DENIED', async () => {
    const input = {
      key: 'k',
      target: { taskId: 't', taskGeneration: 1, startKey: 's' },
      input: { kind: 'ownerMessage', receiptId: 'r' },
    } as const
    await expect(deniedManagedSessions.admitInput('s1', input)).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(deniedManagedSessions.inputResult('s1', { key: 'k' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(
      deniedManagedSessions.admitResolved('s1', input, {
        kind: 'unresolved',
        receiptId: 'r',
        reason: 'receiptUnknown',
      }),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  })
})
