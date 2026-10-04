import { describe, expect, it } from 'vitest'
import { createHostRuntimeClientPorts } from '../../src/runtime/client-ports.js'

describe('Host runtime client assembly', () => {
  it('requires both a read adapter and C14, propagates refusal and never installs a command', async () => {
    const caller = { principalId: 'local' as const, generation: 'daemon-generation' }
    const header = { negotiatedSession: 's1', clientInstanceId: 'ci1', catalogRevision: 1, callId: 'call1' }
    let granted = false
    const error = {
      code: 'denied' as const,
      detailCode: 'c14_denied',
      message: 'denied',
      diagnosticId: 'synthetic-policy',
      retryAdvice: { kind: 'never' as const },
    }
    const queries = {
      'transport.catalogStatus': async () => {
        expect(granted).toBe(true)
        return {
          ok: true as const,
          value: { catalogRevision: 1, mode: 'compatible' as const, reasonCode: null },
        }
      },
      // An extra property supplied by an untyped composition must not open a write route.
      'conversation.cancel': async () => {
        throw new Error('write backend must remain unreachable')
      },
    }
    expect(createHostRuntimeClientPorts(undefined, caller)).toEqual({})
    expect(createHostRuntimeClientPorts({ queries }, caller)).toEqual({})
    const ports = createHostRuntimeClientPorts(
      {
        queries,
        authorize: async (identity, request) => {
          expect(identity).toEqual(caller)
          expect(request).toEqual({ operation: 'transport.catalogStatus', input: { header }, header })
          return granted ? { ok: true, value: true } : { ok: false, error }
        },
      },
      caller,
    )
    expect(Object.keys(ports)).toEqual(['transport.catalogStatus'])
    expect(await ports['transport.catalogStatus']?.({ header }, header)).toEqual({ ok: false, error })
    granted = true
    expect(await ports['transport.catalogStatus']?.({ header }, header)).toMatchObject({ ok: true })
  })
})
