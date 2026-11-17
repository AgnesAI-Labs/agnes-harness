import { rpcError } from '@agnes/protocol'
import { JsonRpcError, TransportClosed } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { gateRefused, ManagedPortsClosed, sharedWorkerReads } from '../src/supervisor/managed-gate-read.js'

describe('reading the managed-session gates over the shared worker link', () => {
  it('passes the worker reply through and keeps a link failure a local error', async () => {
    const replies: unknown[] = []
    const link = {
      async command(method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }) {
        replies.push([method, params, options])
        throw { code: 'E_PRESET_UNSUPPORTED', message: 'agent: unknown agent' }
      },
    }
    const answered = sharedWorkerReads({ acquireSharedWorker: async () => link })
    const refusal = await answered.resolveAgent('@example/companion#worker').catch((error: unknown) => error)
    expect(replies).toEqual([['agents.resolve', { ref: '@example/companion#worker' }, { timeoutMs: 31_000 }]])
    expect(gateRefused(refusal)).toBe(true)
    const down = sharedWorkerReads({
      acquireSharedWorker: async () => {
        throw new Error('shared worker stopping')
      },
    })
    expect(gateRefused(await down.resolveAgent('@example/companion#worker').catch((e: unknown) => e))).toBe(
      false,
    )
    // The pool's own refusals (an activation under way, a full pool, a worker that cannot boot) are not
    // answers about the bundle, whatever error they carry.
    for (const failure of [
      rpcError('OVERLOADED', { retryAfterMs: 1000, reason: 'activation-in-progress' }),
      rpcError('OVERLOADED', { retryAfterMs: 1000 }),
      Object.assign(new Error('boot failed'), { code: 'E_WORKER_BOOT' }),
    ]) {
      const busy = sharedWorkerReads({
        acquireSharedWorker: async () => {
          throw failure
        },
      })
      const error = await busy.resolveAgent('@example/companion#worker').catch((e: unknown) => e)
      expect(gateRefused(error)).toBe(false)
      expect((error as Error).cause).toBe(failure)
    }
  })

  it('counts only answers as refusals', () => {
    for (const answer of [
      { code: 'E_PRESET_UNSUPPORTED', message: 'agent: unknown agent' },
      rpcError('SEMANTIC_REJECTED', { code: 'BUNDLE_UNAVAILABLE' }),
      new JsonRpcError(rpcError('SEMANTIC_REJECTED', { code: 'BUNDLE_UNAVAILABLE' })),
      new JsonRpcError(rpcError('CAPABILITY_DENIED', { reason: 'agent resolution unavailable' })),
    ])
      expect(gateRefused(answer)).toBe(true)
    for (const failure of [
      new Error('worker link closed'),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', syscall: 'connect' }),
      { code: 'E_WORKER', message: 'Worker operation failed.' },
      rpcError('INTERNAL_ERROR', { code: 'INTERNAL' }),
      new JsonRpcError(rpcError('INTERNAL_ERROR', { code: 'CLOSED' })),
      new TransportClosed({ reason: 'eof' }),
      new ManagedPortsClosed(),
      undefined,
      'closed',
    ])
      expect(gateRefused(failure)).toBe(false)
  })
})
