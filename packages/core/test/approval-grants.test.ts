import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, shellTool } from './helpers/open-session.js'

async function initial(
  mode: 'sync' | 'callback',
  verdict: 'allowed-session' | 'allowed-once' = 'allowed-session',
) {
  const clock = () => 1_757_203_200_000,
    storage = new MemoryStorage({ clock }),
    registry = new ToolRegistry()
  let asks = 0,
    executed = 0
  let receipt: { requestId: string; bindingHash: string; expiresAt: string } | null = null
  registry.add(
    shellTool(async () => {
      executed++
      return { content: [{ type: 'text', text: 'executed' }] }
    }),
    { source: 'fixture', trust: 'builtin' },
  )
  const seams = fakeSeams({
    approval: {
      ask: async (req) => {
        if (++asks > 1) return 'rejected'
        if (mode === 'sync') return verdict
        receipt = {
          requestId: req.requestId,
          bindingHash: req.bindingHash,
          expiresAt: new Date(clock() + 1000).toISOString(),
        }
        return { ticket: 'ticket', expiresAt: receipt.expiresAt }
      },
      resume: async () => receipt,
    },
  })
  const h = await openSession({
    storage,
    clock,
    registry,
    seams,
    provider: fakeProvider([toolTurn('shell', { command: 'x' }), textTurn('done')]),
  })
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  const run = () => h.session.run({ until: 'turn-end', signal: new AbortController().signal })
  const first = await run()
  if (mode === 'callback') {
    expect(first.reason).toBe('parked')
    await h.session.resumeApproval('ticket', verdict, { ...actor, id: 'approver' })
    expect((await run()).reason).toBe('completed')
  } else expect(first.reason).toBe('completed')
  return { ...h, storage, clock, registry, seams, asks: () => asks, executed: () => executed }
}
async function reopen(h: Awaited<ReturnType<typeof initial>>, nextActor = actor, command = 'x') {
  await h.session.close()
  const provider = fakeProvider([toolTurn('shell', { command }), textTurn('done')])
  const n = await openSession({
    storage: h.storage,
    clock: h.clock,
    registry: h.registry,
    seams: h.seams,
    provider,
    actor: nextActor,
  })
  try {
    await n.session.enqueue('next-turn', { actor: nextActor, content: [{ type: 'text', text: 'again' }] })
    expect((await n.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    return provider.requests[1]
  } finally {
    await n.session.close()
  }
}

describe('durable session approval grants', () => {
  it.each(['sync', 'callback'] as const)(
    'restores an executed %s allowed-session grant after reopening',
    async (mode) => {
      const h = await initial(mode)
      const request = await reopen(h)
      expect(h.asks()).toBe(1)
      expect(h.executed()).toBe(2)
      expect(JSON.stringify(request?.messages)).toContain('executed')
    },
  )
  it.each(['sync', 'callback'] as const)(
    'does not promote %s allowed-once to a session grant',
    async (mode) => {
      const h = await initial(mode, 'allowed-once')
      const request = await reopen(h)
      expect(h.asks()).toBe(2)
      expect(h.executed()).toBe(1)
      expect(JSON.stringify(request?.messages)).toContain('approval rejected')
    },
  )
  it.each([
    { ...actor, id: 'other' },
    { ...actor, org: 'other' },
  ])('does not transfer a grant to another principal: %j', async (nextActor) => {
    const h = await initial('sync')
    await reopen(h, nextActor)
    expect(h.asks()).toBe(2)
    expect(h.executed()).toBe(1)
  })
  it('restores the scope grant for different arguments after reopening', async () => {
    const h = await initial('sync')
    await reopen(h, actor, 'different')
    expect(h.asks()).toBe(1)
    expect(h.executed()).toBe(2)
  })
  it('refuses to restore a historical grant with an invalid argument binding', async () => {
    const h = await initial('sync', 'allowed-once')
    const call = [...h.session.state.toolCalls.keys()][0]
    if (!call) throw new Error('missing call')
    await h.log.append([
      h.session.ev('approval/asked', {
        requestId: 'bad-grant',
        kind: 'tool',
        toolUseId: call,
        risk: 'always',
        summary: 'fixture',
        bindingHash: '0'.repeat(64),
      }),
      h.session.ev('approval/decided', { requestId: 'bad-grant', verdict: 'allowed-session', via: 'sync' }),
    ])
    await reopen(h)
    expect(h.asks()).toBe(2)
    expect(h.executed()).toBe(1)
  })
})
