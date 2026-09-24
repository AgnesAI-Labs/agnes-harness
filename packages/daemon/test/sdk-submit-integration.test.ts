import { join } from 'node:path'
import { createClient, fileJournal, RequestTimeout } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { bindConnection } from '../src/supervisor/connection.js'
import { listenUnix } from '../src/supervisor/socket.js'
import { openTestHost } from './host.js'
import { localSdkTransport, localSocketPath } from './local-socket-path.js'

it.each(['steer', 'followUp'] as const)(
  'recovers %s from a lost real Ack without enqueueing twice',
  async (kind) => {
    const h = await openTestHost()
    const created = vi.spyOn(h.host, 'createSession')
    const closed: Promise<void>[] = []
    const replies: unknown[] = []
    let drop = true
    const socketPath = localSocketPath(join(h.dataDir, 'daemon', 'submit.sock'))
    const server = await listenUnix(socketPath, (socket) => {
      const endpoint = h.endpoint()
      closed.push(
        bindConnection(
          socket,
          {
            notifications: endpoint.notifications,
            close: () => endpoint.close(),
            async handle(message) {
              const reply = await endpoint.handle(message)
              if ('method' in message && message.method === '_agnes/v1/submit') {
                replies.push(reply)
                if (drop) {
                  drop = false
                  return undefined
                }
              }
              return reply
            },
          },
          { onClose() {} },
        ).closed,
      )
    })
    const dir = join(h.dataDir, 'client-journal')
    const journal = fileJournal(dir, 'actual-client')
    const client = createClient({
      transport: localSdkTransport(socketPath),
      journal,
      timeouts: { request: 200 },
    })
    try {
      const session = await client.session.new({ cwd: h.dataDir })
      const core = await created.mock.results[0]?.value
      if (!core) throw new Error('missing actual core session')
      const before = core.lastSeq
      await expect(session[kind]('queued once', { commandId: 'stable' })).rejects.toBeInstanceOf(
        RequestTimeout,
      )
      const after = core.lastSeq
      expect(after).toBe(before + 1)
      const reopened = fileJournal(dir)
      const pending = await reopened.pending(session.id)
      expect(pending).toHaveLength(1)
      expect(pending[0]?.params).toMatchObject({ clientId: 'actual-client', commandId: 'stable', kind })
      await client.resendPending(session.id)
      expect(core.lastSeq).toBe(after)
      expect(await reopened.pending(session.id)).toEqual([])
      expect(replies[0]).toMatchObject({ result: { seq: after, replayed: false } })
      expect(replies[1]).toMatchObject({ result: { seq: after, replayed: true } })
      expect(await session[kind]('queued once', { commandId: 'stable' })).toBe(after)
      expect(core.lastSeq).toBe(after)
      expect(JSON.stringify(await core.scan({ toSeq: core.lastSeq }))).toContain('queued once')
    } finally {
      await client.close()
      await server.close()
      await Promise.all(closed)
      await h.close()
      created.mockRestore()
    }
  },
)

it('recovers a compact request from a lost real Ack without running the compaction turn twice', async () => {
  const h = await openTestHost()
  const created = vi.spyOn(h.host, 'createSession')
  const closed: Promise<void>[] = []
  const replies: unknown[] = []
  let drop = true
  const socketPath = localSocketPath(join(h.dataDir, 'daemon', 'compact-submit.sock'))
  const server = await listenUnix(socketPath, (socket) => {
    const endpoint = h.endpoint()
    closed.push(
      bindConnection(
        socket,
        {
          notifications: endpoint.notifications,
          close: () => endpoint.close(),
          async handle(message) {
            const reply = await endpoint.handle(message)
            if ('method' in message && message.method === '_agnes/v1/submit' && drop) {
              replies.push(reply)
              drop = false
              return undefined
            }
            if ('method' in message && message.method === '_agnes/v1/submit') replies.push(reply)
            return reply
          },
        },
        { onClose() {} },
      ).closed,
    )
  })
  const dir = join(h.dataDir, 'compact-client-journal')
  const journal = fileJournal(dir, 'actual-client')
  const client = createClient({
    transport: localSdkTransport(socketPath),
    journal,
    timeouts: { request: 200 },
  })
  try {
    const session = await client.session.new({ cwd: h.dataDir })
    const core = await created.mock.results[0]?.value
    if (!core) throw new Error('missing actual core session')
    await expect(
      session.compact('keep the current decision', { commandId: 'stable-compact' }),
    ).rejects.toBeInstanceOf(RequestTimeout)
    const after = core.lastSeq
    expect(await core.scan({ type: 'x/core/manual-compaction', order: 'asc', limit: 10 })).toHaveLength(1)
    expect(await core.scan({ type: 'turn/end', order: 'asc', limit: 10 })).toHaveLength(1)
    await client.resendPending(session.id)
    expect(core.lastSeq).toBe(after)
    expect(await core.scan({ type: 'x/core/manual-compaction', order: 'asc', limit: 10 })).toHaveLength(1)
    expect(await journal.pending(session.id)).toEqual([])
    expect(await session.compact('keep the current decision', { commandId: 'stable-compact' })).toBe(after)
    const detailed = await session.compactDetailed('keep the current decision', {
      commandId: 'stable-compact',
    })
    expect(detailed.state).not.toBe('completed')
    expect(replies[0]).toMatchObject({ result: { compact: detailed, replayed: false } })
    expect(replies.at(-1)).toMatchObject({ result: { compact: detailed, replayed: true } })
    expect(core.lastSeq).toBe(after)
  } finally {
    await client.close()
    await server.close()
    await Promise.all(closed)
    await h.close()
    created.mockRestore()
  }
})
