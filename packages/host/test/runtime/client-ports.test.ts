import { describe, expect, it } from 'vitest'
import { createHostRuntimeClientPorts } from '../../src/runtime/client-ports.js'
import { assembleHostProjectionOwner, createHostProjectionOwner } from '../../src/runtime/projection-owner.js'

describe('Host runtime client assembly', () => {
  it('names a missing public projection export and cannot issue an identity from transport authentication', async () => {
    const owner = createHostProjectionOwner()
    const caller = { principalId: 'local' as const, generation: 'daemon-generation' }
    const header = { negotiatedSession: 's1', clientInstanceId: 'ci1', catalogRevision: 1, callId: 'call1' }
    const ports = createHostRuntimeClientPorts(owner.installation, caller)
    expect(await ports['conversation.open']?.({ sessionId: 'session', limit: 1 }, header)).toMatchObject({
      ok: false,
      error: { detailCode: 'projection_provider_export_unavailable' },
    })
    expect(Object.keys(ports)).toEqual([
      'conversation.open',
      'conversation.history',
      'domain.query',
      'domain.commandStatus',
      'conversation.list',
    ])
    await owner.close()
    expect(await ports['conversation.open']?.({ sessionId: 'session', limit: 1 }, header)).toMatchObject({
      ok: false,
      error: { detailCode: 'projection_owner_closed' },
    })
    const missing = assembleHostProjectionOwner({
      provider: {
        openConversation: async () => {
          throw new Error('unreachable')
        },
        conversationHistory: async () => {
          throw new Error('unreachable')
        },
        listConversations: async () => {
          throw new Error('unreachable')
        },
        snapshot: async () => {
          throw new Error('unreachable')
        },
        commandStatus: async () => {
          throw new Error('unreachable')
        },
        refresh: async () => null,
        close() {},
      },
    })
    expect(
      await createHostRuntimeClientPorts(missing.installation, caller)['conversation.open']?.(
        { sessionId: 'session', limit: 1 },
        header,
      ),
    ).toMatchObject({
      ok: false,
      error: { detailCode: 'projection_context_issuer_unavailable' },
    })
    await missing.close()
  })
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
