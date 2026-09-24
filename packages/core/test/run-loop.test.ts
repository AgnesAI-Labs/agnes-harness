import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider, sent, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

const modelRecord = (route: string, id: string): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

const sig = () => new AbortController().signal
const withRead = () => {
  const r = new ToolRegistry()
  r.add(readTool(), { source: 's', trust: 'builtin' })
  return r
}

describe('run loop', () => {
  it('walking skeleton: prompt, tool call, answer, completed', async () => {
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('read', { path: 'README' }), textTurn('summary')]),
      registry: withRead(),
    })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'read README and summarize' }],
      actor,
    })
    const out = await session.run({ until: 'turn-end', signal: sig() })
    expect(out.reason).toBe('completed')
    const types = (await log.scan({ fromSeq: 1, limit: 200 })).map((e) => e.type)
    expect(types.filter((t) => t === 'step/start')).toHaveLength(2)
    expect(types.filter((t) => t === 'step/end')).toHaveLength(2)
    expect(types[types.length - 2]).toBe('turn/end')
    expect(session.op()).toBeNull()
    expect(session.surface().map((n) => n.kind)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
    expect(session.pendingEffects()).toEqual([])
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'completed' })
  })

  it('a second run on an idle session with nothing queued returns without writing anything', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('a')]) })
    const out = await session.run({ until: 'turn-end', signal: sig() })
    expect(out).toMatchObject({ reason: 'completed', lastSeq: 1 })
    expect(await log.scan({ fromSeq: 1, limit: 10 })).toHaveLength(1)
  })

  it('max_steps ends the turn with max_steps rather than with a generic stop', async () => {
    const preset = { ...presetDefaults(), budget: { ...presetDefaults().budget, maxSteps: 1 } }
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('read', {}), toolTurn('read', {})]),
      registry: withRead(),
      preset,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'loop' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('max_steps')
    expect(await log.scan({ type: 'step/start', limit: 10 })).toHaveLength(1)
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'max_steps' })
  })

  it('budget quote: a rejected quote ends with budget; the deny policy ends without asking', async () => {
    const preset = { ...presetDefaults(), budget: { ...presetDefaults().budget, perRequestCap: 1 } }
    const seams = fakeSeams({
      ledger: { projected: async () => ({ credits: 5, creditSource: 'estimated' }) },
      approval: { ask: async () => 'rejected', resume: async () => null },
    })
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('x')]), preset, seams })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('budget')
    expect((await log.scan({ type: 'approval/asked', limit: 5 }))[0]?.data).toMatchObject({
      kind: 'budget',
      risk: 'budget',
    })
    // The preflight is recorded whether or not the request went out.
    expect((await log.scan({ type: 'budget.state', limit: 5 }))[0]?.data).toMatchObject({
      slot: 'primary',
      creditsCap: 1,
      lastPreflight: { source: 'estimate' },
    })
    const deny = await openSession({
      provider: fakeProvider([textTurn('x')]),
      preset: { ...preset, budget: { ...preset.budget, onExceed: 'deny' } },
      seams,
    })
    await deny.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await deny.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('budget')
    expect(await deny.log.scan({ type: 'approval/asked', limit: 5 })).toHaveLength(0)
  })

  it('a quote under the cap does not ask, and an allowed quote lets the turn proceed', async () => {
    const under = fakeSeams({
      ledger: { projected: async () => ({ credits: 1, creditSource: 'estimated' }) },
    })
    const preset = { ...presetDefaults(), budget: { ...presetDefaults().budget, perRequestCap: 5 } }
    const a = await openSession({ provider: fakeProvider([textTurn('x')]), preset, seams: under })
    await a.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await a.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(await a.log.scan({ type: 'approval/asked', limit: 5 })).toHaveLength(0)
    const over = fakeSeams({ ledger: { projected: async () => ({ credits: 9, creditSource: 'estimated' }) } })
    const b = await openSession({ provider: fakeProvider([textTurn('x')]), preset, seams: over })
    await b.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await b.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(await b.log.scan({ type: 'approval/asked', limit: 5 })).toHaveLength(1)
  })

  it('binds a one-turn budget override durably and does not leak it into the next turn', async () => {
    const preset = {
      ...presetDefaults(),
      budget: { ...presetDefaults().budget, perRequestCap: 5, onExceed: 'deny' as const },
    }
    const seams = fakeSeams({
      ledger: { projected: async () => ({ credits: 9, creditSource: 'estimated' }) },
    })
    const storage = new MemoryStorage()
    const first = await openSession({
      provider: fakeProvider([]),
      preset,
      seams,
      storage,
      key: 'budget-recovery',
    })
    await first.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'budgeted' }],
      actor,
      budget: 10,
    })
    expect(await first.session.step()).toMatchObject({ phase: 'checkpoint' })
    expect(first.session.turnBudgetCap()).toBe(10)
    await first.log.close()

    const reopened = await openSession({
      provider: fakeProvider([textTurn('ok')]),
      preset,
      seams,
      storage,
      key: 'budget-recovery',
      writerRunId: 'r2',
    })
    expect((await reopened.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')

    await reopened.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'preset budget again' }],
      actor,
    })
    expect((await reopened.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('budget')
    const caps = (await reopened.log.scan({ type: 'budget.state', order: 'asc', limit: 10 })).map(
      (event) => (event.data as { creditsCap: number | null }).creditsCap,
    )
    expect(caps).toEqual([10, 5])
  })

  it('rejects an invalid or mid-turn budget override before changing the inbox', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await expect(session.enqueue('next-step', { content: [], actor, budget: 1 })).rejects.toMatchObject({
      code: 'E_ENVELOPE',
    })
    await expect(
      session.enqueue('next-turn', { content: [], actor, budget: Number.POSITIVE_INFINITY }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    expect(session.latest('inbox')).toBeUndefined()
  })

  it.each([
    { model: 'cheap', credits: 1, reason: 'completed' },
    { model: 'expensive', credits: 10, reason: 'budget' },
    { model: undefined, credits: 1, reason: 'completed' },
  ])(
    'preflight prices the selected model ($model), with omitted id taking the default path',
    async ({ model, credits, reason }) => {
      const preset = presetDefaults()
      preset.budget = { ...preset.budget, perRequestCap: 5, onExceed: 'deny' }
      if (model) preset.model.id.primary = model
      const provider = fakeProvider([textTurn('answer')])
      const priced: string[] = []
      const seams = fakeSeams({
        ledger: {
          projected: async ({ model: id }) => {
            priced.push(id)
            return { credits: id === (model ?? 'default') ? credits : 100, creditSource: 'estimated' }
          },
        },
      })
      const { session } = await openSession({ provider, preset, seams })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
      expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe(reason)
      const selected = model ?? 'default'
      // This preset has no tree budget, so only the coarse preflight prices the request.
      expect(priced).toEqual([selected])
      expect(provider.calls).toBe(reason === 'completed' ? 1 : 0)
      if (reason === 'completed') expect(provider.requests[0]?.model).toBe(selected)
    },
  )

  it('a request that passes coarse preflight is priced again only when tree budget applies', async () => {
    const preset = presetDefaults()
    preset.budget = { ...preset.budget, perRequestCap: 5, onExceed: 'deny' }
    preset.treeBudgetCredits = 100
    preset.model.id.primary = 'cheap'
    const provider = fakeProvider([textTurn('answer')])
    Object.assign(provider, { models: () => [modelRecord('default', 'cheap')] })
    const priced: string[] = []
    const seams = fakeSeams({
      ledger: {
        projected: async ({ model: id }) => {
          priced.push(id)
          return { credits: id === 'cheap' ? 1 : 100, creditSource: 'estimated' }
        },
      },
    })
    const { session } = await openSession({ provider, preset, seams })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(priced).toEqual(['cheap', 'cheap'])
    expect(provider.calls).toBe(1)
    expect(provider.requests[0]?.model).toBe('cheap')
  })

  it('an unreachable ledger projects over every cap, so the preflight refuses', async () => {
    const preset = {
      ...presetDefaults(),
      budget: { ...presetDefaults().budget, perRequestCap: 1_000_000, onExceed: 'deny' as const },
    }
    const seams = fakeSeams({
      ledger: {
        projected: async () => {
          throw new Error('gateway down')
        },
      },
    })
    const { session } = await openSession({ provider: fakeProvider([textTurn('x')]), preset, seams })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('budget')
  })

  it('StopGate: a failed verifier plus repair buys one more step; a park verdict parks', async () => {
    let verifies = 0
    const seams = fakeSeams({
      verifier: {
        verify: async (scope) =>
          scope === 'turn' && verifies++ === 0
            ? { verdict: 'fail', reasons: ['no tests'] }
            : { verdict: 'pass', reasons: [] },
      },
      repair: { decide: async () => 'repair' },
    })
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('draft'), textTurn('fixed')]),
      seams,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(await log.scan({ type: 'repair/decision', limit: 5 })).toHaveLength(1)
    expect(await log.scan({ type: 'step/start', limit: 5 })).toHaveLength(2)
    const parkSeams = fakeSeams({
      verifier: {
        verify: async (scope) =>
          scope === 'turn' ? { verdict: 'fail', reasons: ['x'] } : { verdict: 'pass', reasons: [] },
      },
      repair: { decide: async () => 'park' },
      approval: {
        ask: async () => ({ ticket: 'T', expiresAt: '2026-09-08T00:00:00Z' }),
        resume: async () => null,
      },
    })
    const p = await openSession({ provider: fakeProvider([textTurn('draft')]), seams: parkSeams })
    await p.session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    expect((await p.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('parked')
    expect((await p.log.scan({ type: 'approval/asked', limit: 5 }))[0]?.data).toMatchObject({
      kind: 'unknown-outcome',
    })
  })

  it('StopGate: repair rounds are numbered from the decisions already on the ledger', async () => {
    let verifies = 0
    const seams = fakeSeams({
      verifier: {
        verify: async (scope) =>
          scope === 'turn' && verifies++ < 2
            ? { verdict: 'fail', reasons: ['again'] }
            : { verdict: 'pass', reasons: [] },
      },
      repair: { decide: async () => 'repair' },
    })
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('one'), textTurn('two'), textTurn('three')]),
      seams,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    const rounds = (await log.scan({ type: 'repair/decision', limit: 10 })).map(
      (e) => (e.data as { round: number }).round,
    )
    expect(rounds).toEqual([1, 2])
  })

  it('StopGate: a repair verdict of complete finishes despite the failed check', async () => {
    const seams = fakeSeams({
      verifier: {
        verify: async (scope) =>
          scope === 'turn' ? { verdict: 'fail', reasons: ['x'] } : { verdict: 'pass', reasons: [] },
      },
      repair: { decide: async () => 'complete' },
    })
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('draft')]), seams })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(await log.scan({ type: 'step/start', limit: 5 })).toHaveLength(1)
    expect((await log.scan({ type: 'repair/decision', limit: 5 }))[0]?.data).toMatchObject({
      decision: 'complete',
      round: 1,
    })
  })

  it('StopGate: an escalate verdict marks the budget and takes another step', async () => {
    let verifies = 0
    const seams = fakeSeams({
      verifier: {
        verify: async (scope) =>
          scope === 'turn' && verifies++ === 0
            ? { verdict: 'fail', reasons: ['x'] }
            : { verdict: 'pass', reasons: [] },
      },
      repair: { decide: async () => 'escalate' },
    })
    const { session } = await openSession({
      provider: fakeProvider([textTurn('draft'), textTurn('better')]),
      seams,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    await session.run({ until: 'turn-end', signal: sig() })
    expect(session.latest('budget.state')).toMatchObject({ escalate: true })
  })

  it('a turn_stopping hook that says continue buys another step and tells the model why', async () => {
    let asked = 0
    const { session, log } = await openSession({
      provider: fakeProvider([textTurn('draft'), textTurn('more')]),
    })
    session.hooks = {
      ...session.hooks,
      turnStopping: async () =>
        asked++ === 0 ? { action: 'continue', note: 'keep going' } : { action: 'stop' },
    }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    expect(await log.scan({ type: 'step/start', limit: 5 })).toHaveLength(2)
    const notes = (await log.scan({ type: 'user/message', limit: 10 })).filter((e) => e.origin === 'system')
    expect((notes[0]?.data as { content: Array<{ text: string }> } | undefined)?.content[0]?.text).toBe(
      'keep going',
    )
  })

  it('next-step input is claimed at the checkpoint, once', async () => {
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('read', {}), textTurn('done')]),
      registry: withRead(),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.step()
    await session.step()
    await session.enqueue('next-step', {
      content: [{ type: 'text', text: 'also check tests' }],
      actor,
      kind: 'steer',
    })
    await session.run({ until: 'turn-end', signal: sig() })
    const users = await log.scan({ type: 'user/message', limit: 10 })
    expect(users.map((e) => (e.data as { kind?: string }).kind)).toEqual(['prompt', 'steer'])
    expect((session.latest('inbox') as { items: unknown[] }).items).toHaveLength(0)
  })

  it('one checkpoint claims one steer, not the whole queue', async () => {
    const { session, log } = await openSession({
      provider: fakeProvider([toolTurn('read', {}), textTurn('a'), textTurn('b')]),
      registry: withRead(),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await session.step()
    await session.step()
    await session.step()
    await session.step()
    await session.enqueue('next-step', { content: [{ type: 'text', text: 'first' }], actor, kind: 'steer' })
    await session.enqueue('next-step', { content: [{ type: 'text', text: 'second' }], actor, kind: 'steer' })
    // One checkpoint edge: it takes one item and hands the turn back to the model rather than
    // draining the queue before the model has seen any of it.
    expect(await session.step()).toEqual({ phase: 'checkpoint' })
    expect(
      (await log.scan({ type: 'user/message', limit: 10 })).map((e) => (e.data as { kind?: string }).kind),
    ).toEqual(['prompt', 'steer'])
    expect((session.latest('inbox') as { items: unknown[] }).items).toHaveLength(1)
    // And the next edge goes to the model rather than taking the second item too.
    expect(await session.step()).toEqual({ phase: 'inference' })
    expect((session.latest('inbox') as { items: unknown[] }).items).toHaveLength(1)
  })

  it('a threshold that keeps saying yes compacts once per checkpoint, and the turn still ends', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('a'), textTurn('b')]) })
    session.compaction = { shouldCompact: () => true, onOverflow: () => 'failure' }
    session.hooks = {
      ...session.hooks,
      turnStopping: async () => ({ action: 'stop' }),
    }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    const phases = (await log.scan({ type: 'op.state', limit: 100 }))
      .map((e) => (e.data as { phase?: { kind: string } } | null)?.phase?.kind)
      .filter((k) => k === 'compaction')
    // Two checkpoints in this turn, each asking once. The flag stops a resumed checkpoint from
    // compacting again immediately — without it the loop never leaves the compaction phase — but
    // it is written into the resumed phase, not into the fresh checkpoint the settlement writes,
    // so a later step asks again. That is narrower than "once per triggerSeq".
    expect(phases).toHaveLength(2)
    expect(await log.scan({ type: 'step/start', limit: 10 })).toHaveLength(1)
  })

  it('a compaction phase resumes the phase it recorded, and the threshold is checked once', async () => {
    let asked = 0
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('a'), textTurn('b')]) })
    session.compaction = {
      shouldCompact: () => asked++ === 0,
      onOverflow: () => 'failure',
    }
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
    // One compaction phase was entered and left; the threshold was not re-asked on the same trigger.
    const phases = (await log.scan({ type: 'op.state', limit: 50 }))
      .map((e) => (e.data as { phase?: { kind: string } } | null)?.phase?.kind)
      .filter((k) => k === 'compaction')
    expect(phases).toHaveLength(1)
    expect(await log.scan({ type: 'step/start', limit: 5 })).toHaveLength(1)
  })

  it('a failure drain ends the turn with the error it drained on, unless a steer is queued', async () => {
    const fatal = [
      [
        {
          type: 'error' as const,
          reason: 'error' as const,
          code: 'AUTH' as const,
          message: 'no',
          retryable: false,
        },
      ],
    ]
    const { session, log } = await openSession({ provider: fakeProvider(fatal) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig() })).reason).toBe('error')
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({
      reason: 'error',
      error: { code: 'AUTH' },
    })
    const steered = await openSession({ provider: fakeProvider([fatal[0] as never, textTurn('recovered')]) })
    await steered.session.enqueue('next-turn', { content: [{ type: 'text', text: 'do' }], actor })
    await steered.session.step()
    await steered.session.step()
    await steered.session.step()
    expect(steered.session.op()?.phase).toMatchObject({ kind: 'failure_drain' })
    await steered.session.enqueue('next-step', { content: [{ type: 'text', text: 'try again' }], actor })
    expect((await steered.session.run({ until: 'turn-end', signal: sig() })).reason).toBe('completed')
  })
})

describe('run loop safety', () => {
  it('a phase that reports where it went without writing it there is refused, not looped on', async () => {
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('a')]) })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    // Stand in for a checkpoint that returns { phase: 'inference' } but leaves op.state alone.
    const real = session.step.bind(session)
    let calls = 0
    session.step = async () => {
      calls++
      return calls === 1 ? real() : { phase: 'inference' }
    }
    // The bound is a terminal outcome, not a throw: a caller that gets an exception off the
    // declared contract is a caller left with a turn still open and no turn/end to resume from.
    const out = await session.run({ until: 'turn-end', signal: sig() })
    expect(out.reason).toBe('error')
    expect(out.error?.code).toBe('E_RELATION')
    expect(out.error?.message).toContain('no progress')
    // The bound is a small multiple of the step budget, not an unbounded burn.
    expect(calls).toBeLessThan(presetDefaults().budget.maxSteps * 16 + 66)
    const rows = await log.scan({ fromSeq: 1, limit: 500 })
    expect(rows.length).toBeLessThan(25)
    // The turn is closed on the ledger and the reason it was closed is written down beside it.
    expect(rows.filter((e) => e.type === 'x/core/invariant')).toHaveLength(1)
    expect(rows[rows.length - 2]?.type).toBe('turn/end')
    expect(session.op()).toBeNull()
  })

  it('a run that hits the bound with no open turn still ends on the outcome contract', async () => {
    const { session } = await openSession({ provider: fakeProvider([textTurn('a')]) })
    session.step = async () => ({ phase: 'checkpoint' })
    const out = await session.run({ until: 'turn-end', signal: sig() })
    expect(out).toMatchObject({ reason: 'error', error: { code: 'E_RELATION' } })
  })
})

describe('turn-end reasons (fix round 1)', () => {
  it('an interrupt landing at the budget quote ends as aborted, not as out of credit', async () => {
    const preset = { ...presetDefaults(), budget: { ...presetDefaults().budget, perRequestCap: 1 } }
    const ac = new AbortController()
    const seams = fakeSeams({
      ledger: { projected: async () => ({ credits: 5, creditSource: 'estimated' }) },
      approval: {
        // The interrupt reaches the seam, which fails closed to a refusal — the same answer a real
        // rejection gives, which is why the reason has to come from somewhere else.
        ask: async () => {
          ac.abort()
          return 'rejected'
        },
        resume: async () => null,
      },
    })
    const { session, log } = await openSession({ provider: fakeProvider([textTurn('x')]), preset, seams })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    expect((await session.run({ until: 'turn-end', signal: ac.signal })).reason).toBe('aborted')
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ reason: 'aborted' })
  })
})

describe('run outcome error', () => {
  // Mac hand acceptance C2 (2026-09-23): daemon answers a turn that ended in `error` with TURN_ERROR
  // carrying `error: outcome.error`, but run() dropped the turn/end row's error on the ordinary
  // terminal path, so every client saw TURN_ERROR with no cause (a 403 model read as nothing).
  it('a provider failure returns the turn/end error, and the next turn does not inherit it', async () => {
    const { session, log } = await openSession({
      provider: fakeProvider([
        [sent(), { type: 'error', reason: 'error', code: 'AUTH', message: 'status=403', retryable: false }],
        textTurn('ok'),
      ]),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    const failed = await session.run({ until: 'turn-end', signal: sig() })
    expect(failed).toMatchObject({ reason: 'error', error: { code: 'AUTH', message: 'status=403' } })
    // The outcome repeats the ledger row; it is not a second account of the failure.
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({ error: failed.error })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    const ok = await session.run({ until: 'turn-end', signal: sig() })
    expect(ok.reason).toBe('completed')
    expect(ok).not.toHaveProperty('error')
  })
})
