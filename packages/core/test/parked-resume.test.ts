import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { resolvedToolPolicyHash } from '../src/registry/tool-policy.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { continueParked } from '../src/step/parked.js'
import { fakeProvider, type Script, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, shellTool } from './helpers/open-session.js'

const approver = { ...actor, id: 'approver' }
async function setup(scripts: Script[] = [toolTurn('shell', { command: 'echo ok' }), textTurn('finished')]) {
  let now = 1_757_203_200_000,
    asks = 0,
    executions = 0,
    authorizations = 0
  const clock = () => now,
    storage = new MemoryStorage({ clock }),
    registry = new ToolRegistry()
  registry.add(
    shellTool(async (args) => {
      executions++
      return { content: [{ type: 'text', text: `ran:${JSON.stringify(args)}` }] }
    }),
    { source: 'test', trust: 'builtin' },
  )
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
      resume: async (ticket) => receipts.get(ticket) ?? null,
    },
  })
  const provider = fakeProvider(scripts)
  const h = await openSession({ storage, clock, registry, seams, provider })
  await h.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'go' }] })
  expect((await h.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'parked',
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
  it.each(['allowed-once', 'rejected'] as const)(
    'continues %s through core and feeds the real result to the next request',
    async (verdict) => {
      const h = await setup()
      await h.session.resumeApproval('ticket-1', verdict, approver)
      expect((await run(h)).reason).toBe('completed')
      expect(h.asks()).toBe(1)
      expect(h.executions()).toBe(verdict === 'allowed-once' ? 1 : 0)
      expect(h.authorizations()).toBe(1) // The fitted authorization runtime caches its decision for 60s.
      expect(h.provider.calls).toBe(2)
      const result = (await h.log.scan({ type: 'tool/result', toSeq: h.log.lastSeq }))[0]
      expect(result?.data).toMatchObject({ isError: verdict !== 'allowed-once' })
      const text = JSON.stringify(h.provider.requests[1]?.messages)
      expect(text).toContain(verdict === 'allowed-once' ? 'ran:' : 'approval rejected')
      expect(h.session.state.resumedRequests.size).toBe(1)
      expect(h.session.pendingEffects()).toEqual([])
      const seq = h.log.lastSeq
      await run(h)
      expect(h.log.lastSeq).toBe(seq)
    },
  )
  it('continues the default expired rejection without executing the tool', async () => {
    const h = await setup()
    h.advance()
    expect(await h.session.expireApprovals()).toBe(1)
    expect((await run(h)).reason).toBe('completed')
    expect(h.executions()).toBe(0)
    expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('approval rejected')
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
      await reopened.session.resumeApproval('ticket-1', 'allowed-once', approver)
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
      await reopened.session.resumeApproval('ticket-1', 'allowed-once', approver)
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
      await reopened.session.resumeApproval('ticket-1', 'allowed-once', approver)
      expect(await continueParked(reopened.session)).toBe('blocked')
      expect(h.executions()).toBe(0)
      expect(reopened.session.op()).toBeNull()
    } finally {
      await reopened.session.close()
    }
  })
  it('does not reuse the grant for the next model call with identical name and arguments', async () => {
    const h = await setup([toolTurn('shell', {}), toolTurn('shell', {}), textTurn('done')])
    await h.session.resumeApproval('ticket-1', 'allowed-once', approver)
    expect((await run(h)).reason).toBe('parked')
    expect(h.executions()).toBe(1)
    expect(h.asks()).toBe(2)
    const calls = await h.log.scan({ type: 'tool/call', toSeq: h.log.lastSeq })
    expect(calls.map((e) => (e.data as { ordinal: number }).ordinal)).toEqual([0, 1])
    await h.session.resumeApproval('ticket-2', 'allowed-once', approver)
    expect((await run(h)).reason).toBe('completed')
    expect(h.executions()).toBe(2)
  })
  it('honors an allowed-session callback for subsequent identical calls in the same live session', async () => {
    const h = await setup([toolTurn('shell', {}), toolTurn('shell', {}), textTurn('done')])
    await h.session.resumeApproval('ticket-1', 'allowed-session', approver)
    expect((await run(h)).reason).toBe('completed')
    expect(h.executions()).toBe(2)
    expect(h.asks()).toBe(1)
  })

  it('still refuses execution when current authorization denies after its cache expires', async () => {
    const h = await setup()
    await h.session.resumeApproval('ticket-1', 'allowed-once', approver)
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
    await h.session.resumeApproval('ticket-1', 'allowed-session', approver)
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
      expect(owner.session.state.resumedRequests.size).toBe(1)
    } finally {
      await owner.session.close()
    }
  })

  it.each(['allowed-once', 'allowed-session'] as const)(
    'does not reuse %s after an opened continuation is reopened by another principal',
    async (verdict) => {
      const h = await setup()
      await h.session.resumeApproval('ticket-1', verdict, approver)
      expect(await h.session.step()).toEqual({ phase: 'tools' })
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
        expect((await run(foreign)).reason).toBe('parked')
        expect(h.asks()).toBe(2)
        expect(h.executions()).toBe(0)
        const asked = await foreign.log.scan({ type: 'approval/asked', toSeq: foreign.log.lastSeq })
        expect(asked[1]?.actor.id).toBe('other')
      } finally {
        await foreign.session.close()
      }
    },
  )

  it('cancels a resumed call before execution and keeps the next turn usable', async () => {
    const h = await setup()
    try {
      await h.session.resumeApproval('ticket-1', 'allowed-once', approver)
      expect(await h.session.step()).toEqual({ phase: 'tools' })
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
    await h.session.resumeApproval('ticket-1', 'allowed-once', approver)
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
    await h.session.resumeApproval('ticket-1', 'allowed-once', approver)
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
