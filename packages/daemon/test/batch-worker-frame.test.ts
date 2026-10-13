import { duplexPair } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LIMITS } from '../src/config.js'
import { encodeFrame, JsonlDecoder } from '../src/supervisor/framing.js'
import { WorkerPool } from '../src/supervisor/worker-pool.js'

describe('the batch worker request frame', () => {
  it('is taken only from the worker that hosts the session it names', async () => {
    const onRequest = vi.fn(async () => ({ batchId: 'b0123456789ab' }))
    const pool = new WorkerPool({
      config: {
        profileName: 'p',
        dataDir: '/unused',
        socketPath: '/unused/client.sock',
        workersSocketPath: '/unused/worker.sock',
        limits: DEFAULT_LIMITS,
      },
      profile: { name: 'p', hash: 'h1' } as never,
      profileFile: '/unused/profile.json',
      clock: () => 0,
      onEvent: () => undefined,
      onRequest,
      notices: { emit() {} },
    })
    const internals = pool as unknown as {
      slots: Map<string, unknown>
      pendingByToken: Map<string, (link: unknown) => void>
    }
    const claimed = (token: string, slotKey: string, channels: string[]) =>
      new Promise<void>((resolve) => {
        internals.pendingByToken.set(token, (link) => {
          internals.slots.set(slotKey, {
            link,
            channels: new Map(channels.map((c) => [c, {}])),
            resourceControl: slotKey !== '@shared',
          })
          resolve()
        })
      })
    const [poolA, workerA] = duplexPair()
    const [poolB, workerB] = duplexPair()
    const adopted = Promise.all([claimed('token-a', '@shared', ['s']), claimed('token-b', 'service', [])])
    pool.adopt(poolA)
    pool.adopt(poolB)
    const replies = (worker: typeof workerA) => {
      const decoder = new JsonlDecoder()
      const seen: Array<{ requestId: string; result?: unknown; error?: { message: string } }> = []
      worker.on('data', (chunk: Buffer) => {
        for (const frame of decoder.feed(chunk) as typeof seen) seen.push(frame)
      })
      return seen
    }
    const fromA = replies(workerA)
    const fromB = replies(workerB)
    const hello = (token: string, workerGeneration: number, workerKind: 'session' | 'service') =>
      encodeFrame({
        kind: 'hello',
        token,
        workerKey: workerKind === 'session' ? '@shared' : 'service',
        workerKind,
        workerGeneration,
        profileHash: 'h1',
      })
    workerA.write(hello('token-a', 1, 'session'))
    workerB.write(hello('token-b', 2, 'service'))
    await adopted
    const request = (requestId: string, sessionKey: string) =>
      encodeFrame({
        kind: 'request',
        sessionKey,
        requestId,
        method: 'batch',
        params: { op: 'status', sessionKey, batchId: 'b0123456789ab' },
      })
    // Another worker naming the session, and the hosting worker naming a session it does not host.
    workerB.write(request('b1', 's'))
    workerA.write(request('a1', 'other'))
    workerA.write(request('a2', 's'))
    await vi.waitFor(() => expect(fromA.filter((f) => f.requestId)).toHaveLength(2))
    await vi.waitFor(() => expect(fromB.filter((f) => f.requestId)).toHaveLength(1))
    expect(onRequest).toHaveBeenCalledTimes(1)
    expect(onRequest).toHaveBeenCalledWith('s', expect.objectContaining({ requestId: 'a2', method: 'batch' }))
    expect(fromA.find((f) => f.requestId === 'a2')?.result).toEqual({ batchId: 'b0123456789ab' })
    for (const refused of [fromA.find((f) => f.requestId === 'a1'), fromB.find((f) => f.requestId === 'b1')])
      expect(refused?.error?.message).toBe('A batch request must come from the session that makes it.')
    for (const end of [poolA, poolB, workerA, workerB]) end.destroy()
  })
})
