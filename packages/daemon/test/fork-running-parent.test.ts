import type { HostSession } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { openTestHost } from './host.js'

const init = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
}

// The program counter is a register cell, not a row: the daemon's fork gate reads it through the UI
// summary, and a parent with a turn running must still be refused.
describe('forking a parent', () => {
  it('is refused while a turn runs, and allowed once it has ended', async () => {
    const h = await openTestHost()
    const createSession = h.host.createSession.bind(h.host)
    let opened: HostSession | undefined
    vi.spyOn(h.host, 'createSession').mockImplementation(async (opts) => {
      const created = await createSession(opts)
      opened ??= created
      return created
    })
    const ep = h.endpoint({ clock: () => Date.now(), pollMs: 5 })
    try {
      await ep.handle(init)
      await h.addWorkspace(h.dataDir)
      const created = (await ep.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: h.dataDir, mcpServers: [] },
      })) as { result: { sessionId: string } }
      const session = opened
      if (!session) throw new Error('session was not captured')
      const prompt = (text: string) => ({
        actor: session.d.actor,
        content: [{ type: 'text' as const, text }],
        kind: 'prompt' as const,
      })
      await session.enqueue('next-turn', prompt('first'))
      expect(await session.acceptInput()).toBe(true)
      await session.endTurn('completed')
      const [ended] = await session.scan({ type: 'turn/end', order: 'desc', limit: 1 })
      if (!ended) throw new Error('missing completed turn boundary')
      await session.enqueue('next-turn', prompt('second'))
      expect(await session.acceptInput()).toBe(true)
      const fork = (id: number, childKey: string) =>
        ep.handle({
          jsonrpc: '2.0',
          id,
          method: '_agnes/v1/session.fork',
          params: { sessionId: created.result.sessionId, at: ended.seq, childKey },
        })
      expect(await fork(3, 'agnes:fork:running-parent')).toMatchObject({
        error: { data: { code: 'SESSION_BUSY', reason: 'fork requires an idle parent' } },
      })
      await session.endTurn('completed')
      expect(await fork(4, 'agnes:fork:idle-parent')).toMatchObject({
        result: { sessionId: 'agnes:fork:idle-parent' },
      })
    } finally {
      await ep.close()
      await h.close()
    }
  })
})
