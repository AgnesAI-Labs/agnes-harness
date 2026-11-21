import type { CallContext, Handler, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { type EventEnvelope, rpcError } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { artifactHistoryReader, registerWorkerSessionReads } from '../src/supervisor/session-reads.js'

const stored = { sessionId: 's-1', readOnly: true, lastSeq: 3, source: 'stored' }
const hosted = { sessionId: 's-1', readOnly: true, lastSeq: 3, source: 'worker' }

function mount(options: { viewRead?: Parameters<typeof registerWorkerSessionReads>[3]; owner?: () => void }) {
  const handlers = new Map<string, Handler>()
  const endpoint = { register: (method: string, handler: Handler) => handlers.set(method, handler) }
  const command = vi.fn(async () => hosted)
  const pool = { acquireSharedWorker: vi.fn(async () => ({ command })) }
  const requireOwner = vi.fn(options.owner ?? (() => undefined))
  registerWorkerSessionReads(
    endpoint as unknown as LocalEndpoint,
    pool as never,
    requireOwner,
    options.viewRead,
  )
  const context = { signal: new AbortController().signal } as CallContext
  const view = (params: unknown) => (handlers.get('_agnes/v1/session.view') as Handler)(params, context)
  return { view, pool, command, requireOwner, context }
}

describe('session.view', () => {
  it('answers from the stored ledger without starting a worker', async () => {
    const viewRead = vi.fn(async () => stored)
    const { view, pool, requireOwner, context } = mount({ viewRead })
    pool.acquireSharedWorker.mockRejectedValue(new Error('no worker may start for a preview'))
    await expect(view({ sessionId: 's-1', maxNodes: 20 })).resolves.toBe(stored)
    expect(requireOwner).toHaveBeenCalledWith('session.view', 's-1', context)
    expect(viewRead).toHaveBeenCalledWith('s-1', { maxNodes: 20, signal: context.signal })
    expect(pool.acquireSharedWorker).not.toHaveBeenCalled()
  })

  it('falls back to the worker when the stored read fails', async () => {
    const viewRead = vi.fn(async () => {
      throw new Error('stored read failed')
    })
    const { view, command } = mount({ viewRead })
    await expect(view({ sessionId: 's-1' })).resolves.toBe(hosted)
    expect(command).toHaveBeenCalledWith('session.view', { sessionId: 's-1' })
  })

  it('reports a session the ledger does not have as not found', async () => {
    const viewRead = vi.fn(async () => {
      throw Object.assign(new Error('no such session'), { code: 'E_SESSION_NOT_FOUND' })
    })
    const { view, pool } = mount({ viewRead })
    await expect(view({ sessionId: 's-1' })).rejects.toMatchObject({
      data: { code: 'SESSION_NOT_FOUND', sessionId: 's-1' },
    })
    expect(pool.acquireSharedWorker).not.toHaveBeenCalled()
  })

  it('refuses a session the caller does not own before reading anything', async () => {
    const viewRead = vi.fn(async () => stored)
    const { view, pool } = mount({
      viewRead,
      owner: () => {
        throw rpcError('CAPABILITY_DENIED', { sessionId: 'foreign' })
      },
    })
    await expect(view({ sessionId: 'foreign' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(viewRead).not.toHaveBeenCalled()
    expect(pool.acquireSharedWorker).not.toHaveBeenCalled()
  })

  it('reads through the worker when no stored reader is configured', async () => {
    const { view, command } = mount({})
    await expect(view({ sessionId: 's-1', maxNodes: 5 })).resolves.toBe(hosted)
    expect(command).toHaveBeenCalledWith('session.view', { sessionId: 's-1', maxNodes: 5 })
  })
})

describe('recorded artifact history', () => {
  const row = (seq: number, lane = 'main') => ({ seq, lane, type: 'tool/result' }) as EventEnvelope

  it('keeps the initial ledger head and requested lane while paging recorded roots', async () => {
    const events = Array.from({ length: 120 }, (_, i) => row(i + 1, i % 2 ? 'other' : 'main'))
    const reader = artifactHistoryReader(() => async (query) => {
      if (!query.type) return [row(120)]
      return [...events, row(121)]
        .filter((e) => e.seq >= (query.fromSeq ?? 1) && e.seq <= (query.toSeq ?? 0))
        .slice(0, query.limit)
    })
    const history = await reader.read('recorded', 'main', new AbortController().signal)
    expect(history).toEqual(events.filter((e) => e.lane === 'main'))
  })

  it.each(['row limit', 'byte limit', 'invalid order', 'scan failure', 'cancelled'] as const)(
    'refuses a history read on %s',
    async (mode) => {
      const ac = new AbortController()
      const reader = artifactHistoryReader(() => async (query) => {
        if (!query.type) return [row(5000)]
        if (mode === 'scan failure') throw new Error('private adapter detail')
        if (mode === 'cancelled') ac.abort()
        if (mode === 'byte limit') return [{ ...row(1), data: 'x'.repeat(4 * 1024 * 1024) }]
        if (mode === 'invalid order') return [row(2), row(1)]
        return Array.from({ length: 100 }, (_, i) => row((query.fromSeq ?? 1) + i))
      })
      await expect(reader.read('recorded', 'main', ac.signal)).rejects.toThrow()
    },
  )
})
