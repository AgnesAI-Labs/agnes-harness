import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { describe, expect, it } from 'vitest'
import { resolvedToolPolicyHash } from '../src/registry/tool-policy.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { continueParked } from '../src/step/parked.js'
import { answerToolDecision } from './helpers/decision.js'
import { fakeProvider, type Script, sent, textTurn, toolTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, openWorldTool, readTool, shellTool, writeTool } from './helpers/open-session.js'

const approver = { ...actor, id: 'approver' }
async function setup(
  scripts: Script[] = [toolTurn('shell', { command: 'echo ok' }), textTurn('finished')],
  policy: 'notify' | 'refuse' = 'notify',
  taintOnly = false,
) {
  let now = 1_757_203_200_000,
    asks = 0,
    executions = 0,
    authorizations = 0
  const clock = () => now,
    storage = new MemoryStorage(),
    registry = new ToolRegistry()
  const execute = async (args: unknown) => {
    executions++
    return { content: [{ type: 'text' as const, text: `ran:${JSON.stringify(args)}` }] }
  }
  registry.add(taintOnly ? writeTool(execute) : shellTool(execute), { source: 'test', trust: 'builtin' })
  if (taintOnly) registry.add(openWorldTool(), { source: 'test', trust: 'builtin' })
  const receipts = new Map<string, { requestId: string; bindingHash: string; expiresAt: string }>()
  const seams = fakeSeams({
    principals: {
      authorize: async () => {
        authorizations++
        return { decisionId: 'auth', effect: 'allow', reason: 'ok' }
      },
    },
    approval: {
      ask: async (req) => {
        const ticket = `ticket-${++asks}`,
          expiresAt = new Date(now + 1000).toISOString()
        receipts.set(ticket, { requestId: req.requestId, bindingHash: req.bindingHash, expiresAt })
        return { ticket, expiresAt }
      },
    },
  })
  const provider = fakeProvider(
    taintOnly ? [toolTurn('fetch_page', {}), toolTurn('write_note', {}), textTurn('finished')] : scripts,
  )
  const h = await openSession({ storage, clock, registry, seams, provider })
  await h.session.enqueue('next-turn', {
    actor: { ...actor, attrs: { unattendedApproval: policy } },
    origin: 'system',
    content: [{ type: 'text', text: 'go' }],
  })
  expect((await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    policy === 'refuse' ? 'completed' : 'parked',
  )
  return {
    ...h,
    provider,
    storage,
    clock,
    registry,
    seams,
    asks: () => asks,
    executions: () => executions,
    authorizations: () => authorizations,
    advance: (ms = 1000) => {
      now += ms
    },
  }
}
const run = (h: Awaited<ReturnType<typeof openSession>>) =>
  h.session.run({ until: 'turn-end', signal: new AbortController().signal })

describe('single-tool parked continuation', () => {
  it('sends queued input ahead of a parked turn without approving or executing its tool', async () => {
    const h = await setup()
    try {
      for (const text of ['B', 'C'])
        await h.session.enqueue('next-turn', { actor, kind: 'follow_up', content: [{ type: 'text', text }] })
      const selected = (await h.session.projectUI()).pendingInputs?.find((item) => item.preview === 'C')
      if (!selected) throw new Error('missing selected input')
      await h.session.sendQueuedNow(selected.itemId, actor, 'send-C')
      expect(h.session.op()).toBeNull()
      expect(h.executions()).toBe(0)
      expect((await h.session.projectUI()).pendingInputs?.map((item) => item.preview)).toEqual(['C', 'B'])
      expect((await run(h)).reason).toBe('completed')
      expect((await h.session.projectUI()).pendingInputs?.map((item) => item.preview)).toEqual(['B'])
      expect(h.executions()).toBe(0)
    } finally {
      await h.session.close()
    }
  })
  it.each([
    { verdict: 'allowed-once', taintOnly: false },
    { verdict: 'rejected', taintOnly: false },
    { verdict: 'allowed-once', taintOnly: true },
    { verdict: 'rejected', taintOnly: true },
  ] as const)(
    'continues $verdict (taint-only=$taintOnly) through core and feeds the real result to the next request',
    async ({ verdict, taintOnly }) => {
      const h = await setup(undefined, 'notify', taintOnly)
      await answerToolDecision(h.session, 1, verdict, approver)
      expect((await run(h)).reason).toBe('completed')
      expect(h.asks()).toBe(1)
      expect(h.executions()).toBe(verdict === 'allowed-once' ? 1 : 0)
      expect(h.authorizations()).toBe(taintOnly ? 2 : 1) // Authorization is cached per tool for 60s.
      expect(h.provider.calls).toBe(taintOnly ? 3 : 2)
      const result = (await h.log.scan({ type: 'tool/result', toSeq: h.log.lastSeq })).at(-1)
      expect(result?.data).toMatchObject({ isError: verdict !== 'allowed-once' })
      const text = JSON.stringify(h.provider.requests.at(-1)?.messages)
      expect(text).toContain(verdict === 'allowed-once' ? 'ran:' : 'the user rejected this action')
      expect((await h.session.decisions.list()).filter((item) => item.consumption)).toHaveLength(1)
      if (verdict === 'allowed-once') {
        const consumed = (await h.session.decisions.list())[0]?.consumption
        const intent = (await h.log.scan({ type: 'effect/intent', toSeq: h.log.lastSeq })).find(
          (row) => (row.data as { effectId: string }).effectId === consumed?.effectId,
        )
        expect(intent?.data).toMatchObject({
          kind: 'tool',
          tool: { toolUseId: (await h.session.decisions.list())[0]?.request.operationId },
        })
        expect(consumed?.effectId).toBeTruthy()
      }
      expect(h.session.pendingEffects()).toEqual([])
      expect(h.session.op()).toBeNull()
      expect((await h.session.projectUI()).opState).toBeNull()
      const seq = h.log.lastSeq
      await run(h)
      expect(h.log.lastSeq).toBe(seq)
    },
  )
  it("consumes a reopened taint-only continuation's original answer exactly once", async () => {
    const h = await setup(undefined, 'notify', true)
    const handle = (await h.session.decisions.list())[0]?.handle
    if (!handle) throw new Error('missing parked decision')
    await h.session.close()
    const reopened = await openSession({
      storage: h.storage,
      clock: h.clock,
      registry: h.registry,
      seams: h.seams,
      provider: fakeProvider([textTurn('finished')]),
    })
    try {
      expect(h.executions()).toBe(0)
      expect((await reopened.session.decisions.list()).map((item) => item.handle)).toEqual([handle])
      await answerToolDecision(reopened.session, 1, 'allowed-once', approver)
      expect((await run(reopened)).reason).toBe('completed')
      expect(h.executions()).toBe(1)
      expect((await reopened.session.decisions.get(handle)).consumption?.effectId).toBeTruthy()
      expect((await reopened.session.projectUI()).opState).toBeNull()
      const consumptions = (
        await reopened.log.scan({ type: 'decision/state', toSeq: reopened.log.lastSeq })
      ).filter((row) => (row.data as { consumption?: unknown }).consumption)
      expect(consumptions).toHaveLength(1)
      await run(reopened)
      expect(h.executions()).toBe(1)
      expect((await reopened.session.projectUI()).opState).toBeNull()
    } finally {
      await reopened.session.close()
    }
  })
  it('refuses an unattended approval without parking or inventing a human answer', async () => {
    const h = await setup(undefined, 'refuse')
    try {
      expect(h.executions()).toBe(0)
      expect((await h.session.decisions.list())[0]?.result).toMatchObject({
        reason: 'unavailable',
        code: 'unattended-refused',
      })
      expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('unattended-refused')
      expect(await h.log.scan({ type: 'x/core/unattended-refused', limit: 10 })).toHaveLength(1)
    } finally {
      await h.session.close()
    }
  })
  it('continues an expired unanswered request without executing the tool', async () => {
    const h = await setup()
    h.advance(86400000)
    await h.storage.renew(h.session.key, h.session.writerRunId)
    expect((await h.session.decisions.list())[0]?.result?.reason).toBe('expired')
    expect((await run(h)).reason).toBe('completed')
    expect(h.executions()).toBe(0)
    expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('approval unavailable')
    expect((await h.session.decisions.list())[0]?.result).toMatchObject({
      reason: 'expired',
      code: 'deadline',
    })
  })
  it('blocks a continuation whose persisted tool policy hash no longer matches its policy', async () => {
    const h = await setup()
    const rows = structuredClone(await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq, limit: 10_000 }))
    const call = rows.find((row) => row.type === 'tool/call')?.data as { policyHash?: string } | undefined
    if (!call?.policyHash) throw new Error('missing persisted policy hash')
    call.policyHash = 'f'.repeat(64)
    await h.session.close()
    const reopened = await openSession({
      storage: MemoryStorage.fromEvents('k', rows),
      registry: h.registry,
      seams: h.seams,
      provider: fakeProvider([textTurn('must not run')]),
      writerRunId: 'tampered-policy',
    })
    try {
      await answerToolDecision(reopened.session, 1, 'allowed-once', approver)
      expect(await continueParked(reopened.session)).toBe('blocked')
      expect(h.executions()).toBe(0)
      expect(reopened.session.op()).toBeNull()
    } finally {
      await reopened.session.close()
    }
  })
  it('blocks a legacy continuation whose persisted policy lacks scheduler or trust fields', async () => {
    const h = await setup()
    const rows = structuredClone(await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq, limit: 10_000 }))
    const call = rows.find((row) => row.type === 'tool/call')?.data as
      | { resolvedPolicy?: Record<string, unknown>; policyHash?: string }
      | undefined
    if (!call?.resolvedPolicy || !call.policyHash) throw new Error('missing persisted policy')
    delete call.resolvedPolicy.isOpenWorld
    call.policyHash = resolvedToolPolicyHash(call.resolvedPolicy as never)
    await h.session.close()
    const reopened = await openSession({
      storage: MemoryStorage.fromEvents('k', rows),
      registry: h.registry,
      seams: h.seams,
      provider: fakeProvider([textTurn('must not run')]),
      writerRunId: 'legacy-policy',
    })
    try {
      await answerToolDecision(reopened.session, 1, 'allowed-once', approver)
      expect(await continueParked(reopened.session)).toBe('blocked')
      expect(h.executions()).toBe(0)
      expect(reopened.session.op()).toBeNull()
    } finally {
      await reopened.session.close()
    }
  })
  it('blocks a continuation whose source tool call is not trusted model output', async () => {
    const h = await setup()
    const rows = structuredClone(await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq, limit: 10_000 }))
    const call = rows.find((row) => row.type === 'tool/call')
    if (!call) throw new Error('missing persisted call')
    call.origin = 'ext:hostile'
    call.trust = 'untrusted'
    await h.session.close()
    const reopened = await openSession({
      storage: MemoryStorage.fromEvents('k', rows),
      registry: h.registry,
      seams: h.seams,
      provider: fakeProvider([textTurn('must not run')]),
      writerRunId: 'untrusted-call',
    })
    try {
      await answerToolDecision(reopened.session, 1, 'allowed-once', approver)
      expect(await continueParked(reopened.session)).toBe('blocked')
      expect(h.executions()).toBe(0)
      expect(reopened.session.op()).toBeNull()
    } finally {
      await reopened.session.close()
    }
  })
  it('does not reuse the grant for the next model call with identical name and arguments', async () => {
    const h = await setup([toolTurn('shell', {}), toolTurn('shell', {}), textTurn('done')])
    await answerToolDecision(h.session, 1, 'allowed-once', approver)
    expect((await run(h)).reason).toBe('parked')
    expect(h.executions()).toBe(1)
    expect(h.asks()).toBe(2)
    const calls = await h.log.scan({ type: 'tool/call', toSeq: h.log.lastSeq })
    expect(calls.map((e) => (e.data as { ordinal: number }).ordinal)).toEqual([0, 1])
    await answerToolDecision(h.session, 2, 'allowed-once', approver)
    expect((await run(h)).reason).toBe('completed')
    expect(h.executions()).toBe(2)
  })
  it('honors an allowed-session callback for subsequent identical calls in the same live session', async () => {
    const h = await setup([toolTurn('shell', {}), toolTurn('shell', {}), textTurn('done')])
    await answerToolDecision(h.session, 1, 'allowed-session', approver)
    expect((await run(h)).reason).toBe('completed')
    expect(h.executions()).toBe(2)
    expect(h.asks()).toBe(1)
  })

  it('still refuses execution when current authorization denies after its cache expires', async () => {
    const h = await setup()
    await answerToolDecision(h.session, 1, 'allowed-once', approver)
    h.advance(30_000)
    await h.storage.renew(h.session.key, h.session.writerRunId)
    h.advance(31_000)
    h.seams.principals.authorize = async () => ({ decisionId: 'revoked', effect: 'deny', reason: 'revoked' })
    expect((await run(h)).reason).toBe('completed')
    expect(h.executions()).toBe(0)
    expect(h.asks()).toBe(1)
    const result = (await h.log.scan({ type: 'tool/result', toSeq: h.log.lastSeq }))[0]
    expect(result?.data).toMatchObject({ code: 'AUTHZ_DENIED', isError: true })
    expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('revoked')
  })

  it.each([
    { ...actor, id: 'other' },
    { ...actor, org: 'other' },
  ])('keeps another principal from consuming a parked decision: %j', async (other) => {
    const h = await setup()
    await answerToolDecision(h.session, 1, 'allowed-session', approver)
    await h.session.close()
    const foreign = await openSession({
      storage: h.storage,
      clock: h.clock,
      registry: h.registry,
      seams: h.seams,
      actor: other,
      provider: fakeProvider([textTurn('should not run')]),
    })
    try {
      const seq = foreign.log.lastSeq
      expect((await run(foreign)).reason).toBe('parked')
      expect(foreign.log.lastSeq).toBe(seq)
      expect(foreign.session.state.resumedRequests.size).toBe(0)
      expect(h.executions()).toBe(0)
    } finally {
      await foreign.session.close()
    }
    const owner = await openSession({
      storage: h.storage,
      clock: h.clock,
      registry: h.registry,
      seams: h.seams,
      provider: fakeProvider([textTurn('finished')]),
    })
    try {
      expect((await run(owner)).reason).toBe('completed')
      expect(h.executions()).toBe(1)
      expect(h.asks()).toBe(1)
      expect((await owner.session.decisions.list()).filter((item) => item.consumption)).toHaveLength(1)
    } finally {
      await owner.session.close()
    }
  })

  it.each(['allowed-once', 'allowed-session'] as const)(
    'does not reuse %s after an opened continuation is reopened by another principal',
    async (verdict) => {
      const h = await setup()
      await answerToolDecision(h.session, 1, verdict, approver)
      expect(await h.session.step()).toEqual({ outcome: 'running', phase: 'tools' })
      expect(h.executions()).toBe(0)
      await h.session.close()
      const foreign = await openSession({
        storage: h.storage,
        clock: h.clock,
        registry: h.registry,
        seams: h.seams,
        actor: { ...actor, id: 'other' },
        provider: fakeProvider([textTurn('should not run')]),
      })
      try {
        expect((await run(foreign)).reason).toBe('error')
        expect(h.asks()).toBe(1)
        expect(h.executions()).toBe(0)
        expect((await foreign.session.decisions.list())[0]?.consumption).toBeNull()
      } finally {
        await foreign.session.close()
      }
    },
  )

  it('cancels a resumed call before execution and keeps the next turn usable', async () => {
    const h = await setup()
    try {
      await answerToolDecision(h.session, 1, 'allowed-once', approver)
      expect(await h.session.step()).toEqual({ outcome: 'running', phase: 'tools' })
      await h.session.abort(actor)
      expect((await run(h)).reason).toBe('aborted')
      expect(h.executions()).toBe(0)
      const calls = await h.log.scan({ type: 'tool/call', toSeq: h.log.lastSeq })
      const results = await h.log.scan({ type: 'tool/result', toSeq: h.log.lastSeq })
      expect(results).toHaveLength(1)
      expect(results[0]?.data).toMatchObject({ code: 'CANCELLED', cancelledBy: actor })
      expect(results[0]?.sourceEventSeqs).toEqual([calls[0]?.seq])
      await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'continue' }] })
      expect((await run(h)).reason).toBe('completed')
      expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('cancelled before start')
    } finally {
      await h.session.close()
    }
  })

  it('restores a recorded cancellation after reopening the continuation', async () => {
    const h = await setup()
    await answerToolDecision(h.session, 1, 'allowed-once', approver)
    await h.session.step()
    await h.session.abort(actor)
    await h.session.close()
    const provider = fakeProvider([textTurn('must not run')])
    const fresh = await openSession({
      storage: h.storage,
      clock: h.clock,
      registry: h.registry,
      seams: h.seams,
      provider,
    })
    try {
      expect((await run(fresh)).reason).toBe('aborted')
      expect(provider.calls).toBe(0)
      expect(h.executions()).toBe(0)
      const results = await fresh.log.scan({ type: 'tool/result', toSeq: fresh.log.lastSeq })
      expect(results).toHaveLength(1)
      expect(results[0]?.data).toMatchObject({ code: 'CANCELLED', cancelledBy: actor })
      const seq = fresh.log.lastSeq
      await run(fresh)
      expect(fresh.log.lastSeq).toBe(seq)
    } finally {
      await fresh.session.close()
    }
  })

  it('reopens after callback and resumes from persisted records without another ask', async () => {
    const h = await setup()
    await answerToolDecision(h.session, 1, 'allowed-once', approver)
    await h.session.close()
    const provider = fakeProvider([textTurn('finished')])
    const reopened = await openSession({
      storage: h.storage,
      clock: h.clock,
      registry: h.registry,
      seams: h.seams,
      provider,
    })
    try {
      expect((await run(reopened)).reason).toBe('completed')
      expect(h.asks()).toBe(1)
      expect(h.executions()).toBe(1)
      expect(JSON.stringify(provider.requests[0]?.messages)).toContain('ran:')
    } finally {
      await reopened.session.close()
    }
  })
})

describe('batch parked continuation', () => {
  it('resumes a mixed batch: the read is not rerun, the approved call runs, the unstarted call stays closed, results follow call order', async () => {
    const ran: string[] = []
    const registry = new ToolRegistry()
    registry.add(
      readTool(async (args) => {
        ran.push(`read:${JSON.stringify(args)}`)
        return { content: [{ type: 'text' as const, text: 'read ok' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    registry.add(
      shellTool(async (args) => {
        ran.push(`shell:${JSON.stringify(args)}`)
        return { content: [{ type: 'text' as const, text: 'shell ok' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    // One response, three calls: a safe read, a shell that needs approval, and a shell queued behind it.
    const batch: Script = [
      sent(),
      ...[
        { name: 'read', args: { path: 'a' } },
        { name: 'shell', args: { command: 'one' } },
        { name: 'shell', args: { command: 'two' } },
      ].map(({ name, args }, ordinal) => ({
        type: 'toolcall_end' as const,
        call: { toolUseId: '', name, args: args as never, ordinal },
        via: 'native' as const,
      })),
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const provider = fakeProvider([batch, textTurn('finished')])
    const h = await openSession({
      registry,
      provider,
      seams: fakeSeams({
        approval: { ask: async () => ({ ticket: 'ticket-1', expiresAt: '2099-01-01T00:00:00Z' }) },
      }),
    })
    try {
      await h.session.enqueue('next-turn', {
        actor: { ...actor, attrs: { unattendedApproval: 'notify' } },
        origin: 'system',
        content: [{ type: 'text', text: 'go' }],
      })
      expect((await run(h)).reason).toBe('parked')
      expect(ran).toEqual(['read:{"path":"a"}'])
      await answerToolDecision(h.session, 1, 'allowed-once', approver)
      expect((await run(h)).reason).toBe('completed')
      // The read ran once, before the park; only the approved shell ran on resume.
      expect(ran).toEqual(['read:{"path":"a"}', 'shell:{"command":"one"}'])
      expect(provider.calls).toBe(2)
      const messages = (provider.requests.at(-1)?.messages ?? []) as Array<{
        role: string
        toolUseId?: string
        toolCalls?: Array<{ toolUseId: string }>
        content: Array<{ text?: string }>
      }>
      const asked = messages.find((m) => m.toolCalls?.length)?.toolCalls?.map((c) => c.toolUseId)
      const answered = messages.filter((m) => m.role === 'tool_result')
      expect(asked).toHaveLength(3)
      // Each call is answered once, attributed by id, in the order the model asked.
      expect(answered.map((m) => m.toolUseId)).toEqual(asked)
      expect(answered[0]?.content[0]?.text).toContain('read ok')
      expect(answered[1]?.content[0]?.text).toContain('shell ok')
      expect(answered[2]?.content[0]?.text).toContain('not run')
    } finally {
      await h.session.close()
    }
  })
})
