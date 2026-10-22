import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { describe, expect, it } from 'vitest'
import { reduceDecision } from '../../core-ledger/src/reduce/decision.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { listSessionGrants, revokeSessionGrant } from '../src/step/approval-grants.js'
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
        if (++asks > 1) return { verdict: 'rejected' as const, answeredBy: actor }
        if (mode === 'sync') return { verdict, answeredBy: actor }
        receipt = {
          requestId: req.requestId,
          bindingHash: req.bindingHash,
          expiresAt: new Date(clock() + 1000).toISOString(),
        }
        return { ticket: 'ticket', expiresAt: receipt.expiresAt }
      },
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
    await h.session.decisions.answer(
      {
        handle: [...h.session.state.registers.decisionStates.values()][0]!.value.handle,
        revision: 1,
        commandId: 'answer',
        response: { option: verdict, value: null },
      },
      { actor, category: 'human', authorize() {} },
    )
    expect((await run()).reason).toBe('completed')
  } else expect(first.reason).toBe('completed')
  return { ...h, storage, clock, registry, seams, asks: () => asks, executed: () => executed }
}
async function reopen(
  h: Awaited<ReturnType<typeof initial>>,
  nextActor = actor,
  command = 'x',
  changedPolicy = false,
) {
  await h.session.close()
  const provider = fakeProvider([toolTurn('shell', { command }), textTurn('done')])
  const n = await openSession({
    storage: h.storage,
    clock: h.clock,
    registry: h.registry,
    seams: h.seams,
    provider,
    actor: nextActor,
    ...(changedPolicy ? { toolPolicySettings: async () => ({ config: { revision: 'new' } }) } : {}),
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

describe('a rejection reason', () => {
  const base = 'the user rejected this action; do not retry the same call without asking'
  it.each([
    { name: 'none', value: null, expected: base },
    { name: 'blank', value: '  \n ', expected: base },
    { name: 'text', value: 'use the staging db', expected: `${base} The user said: "use the staging db"` },
    {
      name: 'controls and quotes',
      value: 'a\u0007b\nc "quoted" \\',
      expected: `${base} The user said: "a b c \\"quoted\\" \\\\"`,
    },
    { name: 'long', value: 'x'.repeat(600), expected: `${base} The user said: "${'x'.repeat(500)}"` },
  ])('reaches the model after a rejection: $name', async ({ value, expected }) => {
    const clock = () => 1_757_203_200_000
    const registry = new ToolRegistry()
    registry.add(
      shellTool(async () => ({ content: [{ type: 'text', text: 'executed' }] })),
      {
        source: 'fixture',
        trust: 'builtin',
      },
    )
    const provider = fakeProvider([toolTurn('shell', { command: 'x' }), textTurn('done')])
    const h = await openSession({
      storage: new MemoryStorage({ clock }),
      clock,
      registry,
      provider,
      seams: fakeSeams({
        approval: {
          ask: async () => ({ ticket: 'ticket', expiresAt: new Date(clock() + 1000).toISOString() }),
        },
      }),
    })
    await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    const run = () => h.session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect((await run()).reason).toBe('parked')
    await h.session.decisions.answer(
      {
        handle: [...h.session.state.registers.decisionStates.values()][0]!.value.handle,
        revision: 1,
        commandId: 'answer',
        response: { option: 'rejected', value },
      },
      { actor, category: 'human', authorize() {} },
    )
    expect((await run()).reason).toBe('completed')
    const result = provider.requests[1]?.messages.find((m) => m.role === 'tool_result')
    expect(JSON.stringify(result?.content)).toBe(JSON.stringify([{ type: 'text', text: expected }]))
    await h.session.close()
  })
})

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
      expect(JSON.stringify(request?.messages)).toContain('the user rejected this action')
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
    // If the new principal later earns its own grant for the same scope, management must not
    // relabel the old principal's decision as another grant belonging to the new one.
    let asks = 0
    const n = await openSession({
      storage: h.storage,
      clock: h.clock,
      registry: h.registry,
      actor: nextActor,
      seams: fakeSeams({
        approval: {
          ask: async () => ({
            verdict: ++asks === 1 ? ('allowed-session' as const) : ('rejected' as const),
            answeredBy: nextActor,
          }),
        },
      }),
      provider: fakeProvider([
        toolTurn('shell', { command: 'x' }),
        textTurn('done'),
        toolTurn('shell', { command: 'x' }),
        textTurn('done'),
      ]),
    })
    try {
      const run = async () => {
        await n.session.enqueue('next-turn', { actor: nextActor, content: [{ type: 'text', text: 'go' }] })
        await n.session.run({ until: 'turn-end', signal: new AbortController().signal })
      }
      await run()
      const grants = listSessionGrants(n.session)
      expect(grants).toHaveLength(1)
      expect(grants[0]?.issuer).toEqual(nextActor)
      expect(await revokeSessionGrant(n.session, grants[0]!.grantId)).toBe(true)
      expect(listSessionGrants(n.session)).toEqual([])
      await run()
      expect(asks).toBe(2)
      expect(h.executed()).toBe(2)
    } finally {
      await n.session.close()
    }
    // Revoking the second principal's grant leaves the first principal's original grant intact.
    await reopen(h)
    expect(h.asks()).toBe(2)
    expect(h.executed()).toBe(3)
  })
  it.each(['sync', 'callback'] as const)(
    'lists a %s session grant and revokes it for this and every later opening',
    async (mode) => {
      const h = await initial(mode)
      const grants = listSessionGrants(h.session)
      expect(grants).toEqual([
        {
          grantId: expect.any(String),
          toolId: 'shell',
          scope: expect.any(String),
          createdAt: new Date(h.clock()).toISOString(),
          issuer: actor,
        },
      ])
      const grantId = grants[0]?.grantId as string
      expect(await revokeSessionGrant(h.session, 'not-a-grant')).toBe(false)
      expect(await revokeSessionGrant(h.session, grantId)).toBe(true)
      expect(listSessionGrants(h.session)).toEqual([])
      expect(await revokeSessionGrant(h.session, grantId)).toBe(false)
      // The next call of the same tool asks again; the fixture's second answer is a rejection.
      await reopen(h)
      expect(h.asks()).toBe(2)
      expect(h.executed()).toBe(1)
    },
  )
  it('accepts no other write to a consumed decision', async () => {
    const consumed = async (verdict: 'allowed-session' | 'allowed-once') => {
      const h = await initial('sync', verdict)
      const [cell] = [...h.session.state.registers.decisionStates.values()]
      await h.session.close()
      if (!cell?.value.consumption) throw new Error('fixture decision was not consumed')
      return cell.value
    }
    const write = (previous: Awaited<ReturnType<typeof consumed>>, change: Record<string, unknown>) =>
      reduceDecision(previous, {
        origin: 'system',
        trust: 'trusted',
        register: 'decision/state',
        lane: previous.request.lane,
        seq: 999,
        data: { ...previous, revision: previous.revision + 1, ...change },
      } as never)
    const at = '2025-09-07T00:00:01.000Z'
    const session = await consumed('allowed-session')
    expect(write(session, { invalidation: { at, code: 'grant-revoked' } }).invalidation?.code).toBe(
      'grant-revoked',
    )
    // Any other invalidation, a rewritten consumption, or a single-call answer stays terminal.
    expect(() => write(session, { invalidation: { at, code: 'stopped' } })).toThrow('terminal state')
    expect(() =>
      write(session, {
        invalidation: { at, code: 'grant-revoked' },
        consumption: { ...session.consumption, effectId: 'another-effect' },
      }),
    ).toThrow('terminal state')
    expect(() =>
      write(
        { ...session, invalidation: { at, code: 'grant-revoked' } },
        { invalidation: { at, code: 'grant-revoked' } },
      ),
    ).toThrow('terminal state')
    const once = await consumed('allowed-once')
    expect(() => write(once, { invalidation: { at, code: 'grant-revoked' } })).toThrow('terminal state')
  })
  it('lists nothing for an answer that allowed a single call', async () => {
    const h = await initial('sync', 'allowed-once')
    expect(listSessionGrants(h.session)).toEqual([])
    await h.session.close()
  })
  it('restores the scope grant for different arguments after reopening', async () => {
    const h = await initial('sync')
    await reopen(h, actor, 'different')
    expect(h.asks()).toBe(1)
    expect(h.executed()).toBe(2)
  })
  it.each(['definition', 'policy'] as const)(
    'rechecks an executed session grant after %s changes',
    async (changed) => {
      const h = await initial('sync')
      const registry = new ToolRegistry()
      registry.add(
        shellTool(async () => {
          throw new Error('changed tool must not execute')
        }),
        {
          source: 'fixture',
          trust: 'builtin',
          ...(changed === 'definition' ? { packageVersion: '2.0.0' } : {}),
        },
      )
      await reopen({ ...h, registry }, actor, 'x', changed === 'policy')
      expect(h.asks()).toBe(2)
      expect(h.executed()).toBe(1)
    },
  )
})
