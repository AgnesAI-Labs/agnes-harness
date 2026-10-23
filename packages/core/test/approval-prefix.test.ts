import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { DecisionSnapshot } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { decisionSubjectDigest, reduceDecision } from '../../core-ledger/src/reduce/decision.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { listSessionGrants, revokeSessionGrant } from '../src/step/approval-grants.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, openWorldTool, shellTool } from './helpers/open-session.js'

const clock = () => 1_757_203_200_000
const human = { actor, category: 'human' as const, authorize() {} }

function shell(run: () => void, over: Partial<{ requiresApproval: 'always' | 'destructive' }> = {}) {
  const base = shellTool(async () => {
    run()
    return { content: [{ type: 'text', text: 'executed' }] }
  }) as { meta: Record<string, unknown> }
  return { ...base, meta: { ...base.meta, commandArg: 'command', ...over } } as never
}

/** A session that parks on every approval, so a test answers it the way a client would. */
async function setup(commands: string[], over: Parameters<typeof shell>[1] = {}, storage?: MemoryStorage) {
  const store = storage ?? new MemoryStorage({ clock })
  const registry = new ToolRegistry()
  let executed = 0
  registry.add(
    shell(() => executed++, over),
    { source: 'fixture', trust: 'builtin' },
  )
  let asks = 0
  const h = await openSession({
    storage: store,
    clock,
    registry,
    seams: fakeSeams({
      approval: {
        ask: async (req) => {
          asks++
          return { ticket: `t${asks}`, expiresAt: new Date(clock() + 1000).toISOString() }
        },
      },
    }),
    provider: fakeProvider([...commands.map((command) => toolTurn('shell', { command })), textTurn('done')]),
  })
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  const run = () => h.session.run({ until: 'turn-end', signal: new AbortController().signal })
  const pending = (): DecisionSnapshot =>
    [...h.session.state.registers.decisionStates.values()]
      .map((cell) => cell.value)
      .filter((value) => !value.result)
      .at(-1) as DecisionSnapshot
  const answer = (option: string) => {
    const value = pending()
    return h.session.decisions.answer(
      {
        handle: value.handle,
        revision: value.revision,
        commandId: `a${asks}${option}`,
        response: { option, value: null },
      },
      human,
    )
  }
  return { h, run, pending, answer, asks: () => asks, executed: () => executed, store, registry }
}

describe('shell prefix approvals', () => {
  it('offers the prefix in the subject, not in the listed options, and honours it for later commands', async () => {
    const t = await setup(['git status', 'git status -s', 'git status && git status --short', 'git statusx'])
    expect((await t.run()).reason).toBe('parked')
    const request = t.pending().request
    expect(request.spec.options).toEqual(['allowed-once', 'allowed-session', 'rejected'])
    expect((request.spec.subject as { prefixGrant: unknown }).prefixGrant).toEqual({
      tokens: ['git', 'status'],
      scope: 'shell:prefix:["git","status"]',
    })
    const node = (await t.h.session.projectUI()).nodes.find(
      (n) => n.kind === 'approval' && n.state === 'pending',
    )
    expect(node).toMatchObject({
      options: ['allow_once', 'allow_always', 'reject_once'],
      prefixGrant: { tokens: ['git', 'status'] },
      origin: { package: 'fixture' },
    })
    expect(node).toHaveProperty('grantScopes', ['tool:shell:execute'])
    const snapshot = structuredClone(t.pending())
    const forged = structuredClone(snapshot)
    ;(forged.request.spec.subject as { prefixGrant: unknown }).prefixGrant = {
      tokens: ['git', 'push'],
      scope: 'shell:prefix:["git","push"]',
    }
    expect(decisionSubjectDigest(forged.request.spec.subject)).not.toBe(snapshot.request.subjectDigest)
    expect(() =>
      reduceDecision(undefined, {
        origin: 'system',
        trust: 'trusted',
        register: 'decision/state',
        lane: snapshot.request.lane,
        data: forged,
      } as never),
    ).toThrow('subject digest')
    await t.answer('allow_prefix_session')
    // The next two commands start with the prefix and run unasked; the fourth does not and asks.
    expect((await t.run()).reason).toBe('parked')
    expect({ asks: t.asks(), executed: t.executed() }).toEqual({ asks: 2, executed: 3 })
    expect(listSessionGrants(t.h.session as never).map((grant) => grant.scope)).toEqual([
      'shell:prefix:["git","status"]',
    ])
  })

  it('does not accept the prefix answer when none was offered', async () => {
    const t = await setup(['bash -c ls', 'git status; rm x'])
    await t.run()
    expect(t.pending().request.spec.subject).not.toHaveProperty('prefixGrant')
    await expect(t.answer('allow_prefix_session')).rejects.toThrow(/UNOFFERED_ANSWER/)
  })

  it('neither offers nor honours a prefix for an always-approval tool', async () => {
    const t = await setup(['git status', 'git status'], { requiresApproval: 'always' })
    await t.run()
    expect(t.pending().request.spec.subject).not.toHaveProperty('prefixGrant')
    await expect(t.answer('allow_prefix_session')).rejects.toThrow(/UNOFFERED_ANSWER/)
  })

  it('does not honour a granted prefix once untrusted content is in the turn', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.add(
      shell(() => executed++),
      { source: 'fixture', trust: 'builtin' },
    )
    registry.add(openWorldTool(), { source: 'fixture', trust: 'builtin' })
    let asks = 0
    const h = await openSession({
      storage: new MemoryStorage({ clock }),
      clock,
      registry,
      seams: fakeSeams({
        approval: {
          ask: async () => {
            asks++
            return { ticket: `t${asks}`, expiresAt: new Date(clock() + 1000).toISOString() }
          },
        },
      }),
      provider: fakeProvider([
        toolTurn('shell', { command: 'git status' }),
        textTurn('one'),
        toolTurn('fetch_page', {}),
        toolTurn('shell', { command: 'git status' }),
        textTurn('two'),
      ]),
    })
    const run = () => h.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
    await run()
    const value = [...h.session.state.registers.decisionStates.values()][0]?.value as DecisionSnapshot
    await h.session.decisions.answer(
      {
        handle: value.handle,
        revision: value.revision,
        commandId: 'a',
        response: { option: 'allow_prefix_session', value: null },
      },
      human,
    )
    expect((await run()).reason).toBe('completed')
    expect({ asks, executed }).toEqual({ asks: 1, executed: 1 })
    await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'again' }] })
    expect((await run()).reason).toBe('parked')
    expect({ asks, executed }).toEqual({ asks: 2, executed: 1 })
  })

  it('restores after reopening, lists as a prefix scope, and asks again once revoked', async () => {
    const t = await setup(['git status'])
    await t.run()
    await t.answer('allow_prefix_session')
    expect((await t.run()).reason).toBe('completed')
    await t.h.session.close()
    const reopened = await openSession({
      storage: t.store,
      clock,
      registry: t.registry,
      seams: fakeSeams({
        approval: { ask: async () => ({ verdict: 'rejected' as const, answeredBy: actor }) },
      }),
      provider: fakeProvider([toolTurn('shell', { command: 'git status -s' }), textTurn('ok')]),
    })
    await reopened.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'again' }] })
    expect(
      (await reopened.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
    ).toBe('completed')
    expect(t.executed()).toBe(2)
    const [grant] = listSessionGrants(reopened.session as never)
    expect(grant?.scope).toBe('shell:prefix:["git","status"]')
    expect(await revokeSessionGrant(reopened.session as never, grant?.grantId ?? '')).toBe(true)
    expect(listSessionGrants(reopened.session as never)).toEqual([])
    await reopened.session.close()
  })
})
