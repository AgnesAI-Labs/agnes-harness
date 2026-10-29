import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { registerSessionView } from '../src/local/methods/session-view.js'

const view = {
  sessionId: 'owned',
  readOnly: true,
  lastSeq: 3,
  timeline: { sessionId: 'owned', upto: 3, generation: 1, opState: null, nodes: [], turns: [] },
  history: { hasEarlier: false, startIndex: 0, totalNodes: 0 },
}

function endpoint(readSessionView: (...args: unknown[]) => Promise<unknown>) {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  registerSessionView(ep, { readSessionView } as never, (_method, id) => {
    if (id !== 'owned') throw rpcError('CAPABILITY_DENIED')
  })
  return (sessionId: string, extra = {}) =>
    ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: '_agnes/v1/session.view',
      params: { sessionId, ...extra },
    }) as Promise<{ result?: unknown; error?: { data?: { code?: string } } }>
}

it('serves the recorded conversation straight from the host without opening the session', async () => {
  const read = vi.fn(async () => view)
  const call = endpoint(read)
  expect((await call('owned', { maxNodes: 50 })).result).toEqual(view)
  expect(read).toHaveBeenCalledWith('owned', { maxNodes: 50, signal: expect.any(AbortSignal) })
})

it('checks ownership before reading anything', async () => {
  const read = vi.fn(async () => view)
  expect((await endpoint(read)('foreign')).error?.data?.code).toBe('CAPABILITY_DENIED')
  expect(read).not.toHaveBeenCalled()
})
