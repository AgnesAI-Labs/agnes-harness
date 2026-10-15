import type { Event } from '@agnes/core-common/types'
import { traceFold } from '@agnes/core-ledger/project/trace'
import { projectUI } from '@agnes/core-ledger/project/ui'
import type { UISpan } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { UITurn as UITurnSchema } from '@agnes/protocol/gen/agnes-v1'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answeredDecision, pendingDecision } from '../../core-ledger/testkit/decision.js'
import { actor } from './helpers/open-session.js'

const tokens = { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 3 }
const enforcement = { level: 'full' as const, scope: ['process' as const] }

let seq = 0
const event = (type: string, data: Event['data'], extra: Partial<Event> = {}): Event => {
  seq += 1
  return {
    seq,
    ts: new Date(Date.UTC(2026, 8, 17, 0, 0, seq)).toISOString(),
    id: `01K0000000000000000000${String(seq).padStart(4, '0')}`,
    type,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
    ...extra,
  }
}

const reset = () => {
  seq = 0
}

const byKind = (span: UISpan, kind: UISpan['kind']): UISpan[] => [
  ...(span.kind === kind ? [span] : []),
  ...span.children.flatMap((child) => byKind(child, kind)),
]

afterEach(() => {
  vi.restoreAllMocks()
  reset()
})

describe('projectUI trace fold', () => {
  it('nests step, generation and tool with ledger durations and no root token totals', async () => {
    const events = [
      event('user/message', { content: [{ type: 'text', text: 'check' }] }),
      event('turn/start', { turn: 1, trigger: 'prompt' }),
      event('step/start', { turn: 1, step: 1 }),
      event('effect/intent', { effectId: 'inf-1', kind: 'inference', replay: 'safe' }),
      event('cost/ledger', {
        purpose: 'inference',
        effectId: 'inf-1',
        tokens,
        creditSource: 'gateway',
        model: 'deepseek-v4-pro',
        credits: 1.5,
        billing: { usdMicros: 25, source: 'gateway', subscription: true },
        timing: { ttftMs: 4, durationMs: 20 },
      }),
      event('tool/call', { toolUseId: 'tool-1', name: 'bash', args: {}, ordinal: 0 }),
      event('effect/intent', {
        effectId: 'tool-e1',
        kind: 'tool',
        replay: 'never',
        tool: { toolUseId: 'tool-1', name: 'bash' },
      }),
      event('effect/settled', { effectId: 'tool-e1', outcome: 'ok', durationMs: 40 }),
      event('tool/result', {
        toolUseId: 'tool-1',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        enforcement,
        authz: { decisionId: 'd1' },
      }),
      event('step/end', { turn: 1, step: 1 }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const timeline = await projectUI(events, { sessionKey: 'trace-main' })
    expect(timeline.turns).toHaveLength(1)
    const turn = timeline.turns[0]
    if (!turn) throw new Error('expected one projected turn')
    expect(validateAgainst(UITurnSchema, turn).ok).toBe(true)
    expect(turn.trace).toBeDefined()
    expect(turn.trace?.kind).toBe('turn')
    expect(turn.trace).not.toHaveProperty('tokens')
    expect(turn.usage.totals).toEqual({ input: 10, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 3 })
    const steps = turn.trace?.children.filter((child) => child.kind === 'step') ?? []
    expect(steps).toHaveLength(1)
    const generation = steps[0]?.children.find((child) => child.kind === 'generation')
    const tool = steps[0]?.children.find((child) => child.kind === 'tool')
    expect(generation?.ttftMs).toBe(4)
    expect(generation?.durationMs).toBe(20)
    expect(generation?.model).toBe('deepseek-v4-pro')
    expect(tool?.durationMs).toBe(40)
    expect(tool?.name).toBe('bash')
  })

  it('keeps a UITurn without trace valid and omits trace when fold throws', async () => {
    const bare = {
      id: 'turn:1',
      turn: 1,
      startSeq: 1,
      startedAt: '2026-09-17T00:00:00.000Z',
      status: 'completed' as const,
      nodeIds: [],
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        reasoningComplete: false,
        billingComplete: false,
        calls: [],
      },
      inherited: false,
      forkable: false,
    }
    expect(validateAgainst(UITurnSchema, bare).ok).toBe(true)
    vi.spyOn(traceFold, 'applyTraceEvent').mockImplementation(() => {
      throw new Error('fold-failed')
    })
    const events = [
      event('turn/start', { turn: 1, trigger: 'prompt' }),
      event('step/start', { turn: 1, step: 1 }),
      event('effect/intent', { effectId: 'inf-1', kind: 'inference', replay: 'safe' }),
      event('cost/ledger', {
        purpose: 'inference',
        effectId: 'inf-1',
        tokens,
        creditSource: 'estimated',
        model: 'm',
      }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const timeline = await projectUI(events, { sessionKey: 'trace-throw' })
    expect(timeline.turns).toHaveLength(1)
    expect(timeline.turns[0]?.usage.calls).toHaveLength(1)
    expect(timeline.turns[0]?.trace).toBeUndefined()
    expect(timeline.nodes.length).toBeGreaterThan(0)
  })

  it('keeps failed inference retries as sibling generations', async () => {
    const cost = (effectId: string, interrupted: boolean) =>
      event('cost/ledger', {
        purpose: 'inference',
        effectId,
        tokens,
        creditSource: 'estimated',
        model: 'm',
        timing: { durationMs: 5 },
        ...(interrupted ? { interrupted: true } : {}),
      })
    const events = [
      event('turn/start', { turn: 1, trigger: 'prompt' }),
      event('step/start', { turn: 1, step: 1 }),
      event('effect/intent', { effectId: 'a', kind: 'inference', replay: 'safe' }),
      cost('a', true),
      event('effect/intent', { effectId: 'b', kind: 'inference', replay: 'safe' }),
      cost('b', true),
      event('effect/intent', { effectId: 'c', kind: 'inference', replay: 'safe' }),
      cost('c', false),
      event('step/end', { turn: 1, step: 1 }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const timeline = await projectUI(events, { sessionKey: 'trace-retry' })
    const generations = byKind(timeline.turns[0]?.trace as UISpan, 'generation')
    expect(generations.map((item) => item.status)).toEqual(['failed', 'failed', 'completed'])
  })

  it('omits ttft when the cost row has no timing', async () => {
    const events = [
      event('turn/start', { turn: 1, trigger: 'prompt' }),
      event('step/start', { turn: 1, step: 1 }),
      event('effect/intent', { effectId: 'inf-1', kind: 'inference', replay: 'safe' }),
      event('cost/ledger', {
        purpose: 'inference',
        effectId: 'inf-1',
        tokens,
        creditSource: 'estimated',
        model: 'm',
      }),
      event('step/end', { turn: 1, step: 1 }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const generation = byKind(
      timelineTrace(await projectUI(events, { sessionKey: 'trace-old' })),
      'generation',
    )[0]
    expect(generation?.ttftMs).toBeUndefined()
    expect(generation?.durationMs).toBeDefined()
  })

  it('records approval wait and rejected tools', async () => {
    const events = [
      event('turn/start', { turn: 1, trigger: 'prompt' }),
      event('step/start', { turn: 1, step: 1 }),
      event('tool/call', { toolUseId: 'tool-1', name: 'shell', args: {}, ordinal: 0 }),
      event('decision/state', pendingDecision('approval-1', { operationId: 'tool-1' }), {
        register: 'decision/state',
      }),
      event(
        'decision/state',
        answeredDecision(pendingDecision('approval-1', { operationId: 'tool-1' }), 5, 'rejected'),
        { register: 'decision/state' },
      ),
      event('step/end', { turn: 1, step: 1 }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const root = timelineTrace(await projectUI(events, { sessionKey: 'trace-approval' }))
    const approval = byKind(root, 'approval')[0]
    const tool = byKind(root, 'tool')[0]
    expect(approval?.status).toBe('failed')
    expect(tool?.status).toBe('failed')
  })

  it('places compaction and title generation outside model step numbering', async () => {
    const events = [
      event('turn/start', { turn: 1, trigger: 'prompt' }),
      event('step/start', { turn: 1, step: 1 }),
      event('effect/intent', { effectId: 'inf-1', kind: 'inference', replay: 'safe' }),
      event('cost/ledger', {
        purpose: 'inference',
        effectId: 'inf-1',
        tokens,
        creditSource: 'estimated',
        model: 'm',
        timing: { durationMs: 8 },
      }),
      event('step/end', { turn: 1, step: 1 }),
      event('effect/intent', { effectId: 'comp-1', kind: 'compaction', replay: 'safe' }),
      event('cost/ledger', {
        purpose: 'compaction',
        effectId: 'comp-1',
        tokens,
        creditSource: 'estimated',
        model: 'm',
        timing: { durationMs: 3 },
      }),
      event('cost/ledger', {
        purpose: 'title',
        effectId: 'title-1',
        tokens,
        creditSource: 'estimated',
        model: 'm',
        sourceTurn: 1,
        timing: { durationMs: 2 },
      }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const root = timelineTrace(await projectUI(events, { sessionKey: 'trace-extra' }))
    const steps = root.children.filter((child) => child.kind === 'step')
    expect(steps).toHaveLength(1)
    expect(steps[0]?.children.some((child) => child.kind === 'compaction')).toBe(false)
    expect(root.children.some((child) => child.kind === 'compaction' || child.purpose === 'compaction')).toBe(
      true,
    )
    const title = byKind(root, 'generation').find((item) => item.purpose === 'title')
    expect(title).toBeDefined()
    expect(steps[0]?.children).not.toContain(title)
  })

  describe('side calls', () => {
    const sideCost = (
      effectId: string,
      extra: Record<string, unknown> = {},
      timing: { durationMs: number } | false = { durationMs: 30 },
    ) =>
      event('cost/ledger', {
        purpose: 'side-call',
        effectId,
        tokens: { input: 189, output: 12, cacheRead: 0, cacheWrite: 0 },
        credits: 0.5,
        creditSource: 'gateway',
        model: 'side-model',
        route: 'side-route',
        adapter: 'side-adapter',
        endpointHost: 'side.example',
        ...(timing ? { timing } : {}),
        ...extra,
      })

    it('mounts a side call as a generation under the open step and fills it from its cost row', async () => {
      const events = [
        event('turn/start', { turn: 1, trigger: 'prompt' }),
        event('step/start', { turn: 1, step: 1 }),
        event('effect/intent', { effectId: 'side:a', kind: 'side-call', replay: 'never' }),
        sideCost('side:a'),
        // Settled arrives after the cost row has closed the span: the duration the cost row measured stays.
        event('effect/settled', { effectId: 'side:a', outcome: 'ok', durationMs: 31 }),
        event('effect/intent', { effectId: 'inf-1', kind: 'inference', replay: 'safe' }),
        event('cost/ledger', {
          purpose: 'inference',
          effectId: 'inf-1',
          tokens,
          creditSource: 'estimated',
          model: 'm',
          timing: { durationMs: 8 },
        }),
        event('step/end', { turn: 1, step: 1 }),
        event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ]
      const root = timelineTrace(await projectUI(events, { sessionKey: 'trace-side-step' }))
      const step = root.children.find((child) => child.kind === 'step')
      const side = step?.children.find((child) => child.id === 'span:side-call:side:a')
      expect(side).toMatchObject({
        kind: 'generation',
        effectId: 'side:a',
        purpose: 'side-call',
        model: 'side-model',
        name: 'side-model',
        status: 'completed',
        durationMs: 30,
        callSeq: 4,
      })
      expect(root.children.some((child) => child.id === 'span:side-call:side:a')).toBe(false)
      // The conversation's own call is still the only inference generation in the step.
      expect(byKind(root, 'generation').filter((span) => span.purpose === 'inference')).toHaveLength(1)
    })

    it('mounts a side call outside any open step on the turn root', async () => {
      const events = [
        event('turn/start', { turn: 1, trigger: 'prompt' }),
        event('effect/intent', { effectId: 'side:early', kind: 'side-call', replay: 'never' }),
        sideCost('side:early'),
        event('step/start', { turn: 1, step: 1 }),
        event('step/end', { turn: 1, step: 1 }),
        event('effect/intent', { effectId: 'side:late', kind: 'side-call', replay: 'never' }),
        sideCost('side:late'),
        event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ]
      const root = timelineTrace(await projectUI(events, { sessionKey: 'trace-side-root' }))
      expect(root.children.filter((child) => child.kind === 'step')).toHaveLength(1)
      expect(root.children.map((child) => child.id)).toEqual(
        expect.arrayContaining(['span:side-call:side:early', 'span:side-call:side:late']),
      )
      for (const span of root.children.filter((child) => child.kind === 'generation'))
        expect(span).toMatchObject({ purpose: 'side-call', status: 'completed' })
      expect(byKind(root, 'step').flatMap((step) => step.children)).toEqual([])
    })

    it('closes the span on effect/settled, recording its code and duration', async () => {
      const events = [
        event('turn/start', { turn: 1, trigger: 'prompt' }),
        event('step/start', { turn: 1, step: 1 }),
        event('effect/intent', { effectId: 'side:slow', kind: 'side-call', replay: 'never' }),
        event('effect/settled', {
          effectId: 'side:slow',
          outcome: 'error',
          code: 'TIMEOUT',
          durationMs: 200,
        }),
        sideCost('side:slow', { interrupted: true, creditSource: 'estimated' }, false),
        event('step/end', { turn: 1, step: 1 }),
        event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ]
      const root = timelineTrace(await projectUI(events, { sessionKey: 'trace-side-settled' }))
      const side = byKind(root, 'generation').find((span) => span.effectId === 'side:slow')
      expect(side).toMatchObject({
        status: 'failed',
        durationMs: 200,
        error: { code: 'TIMEOUT' },
        model: 'side-model',
        purpose: 'side-call',
      })
      expect(side?.endSeq).toBeDefined()
      expect(side?.callSeq).toBeDefined()
    })

    describe('when the cost row closes the span before effect/settled arrives', () => {
      // Each call is its own ledger. The rows are built by a callback so their sequence numbers follow the
      // turn and step rows that open it.
      const traceOf = async (effectId: string, rows: () => Event[]) => {
        reset()
        const events = [
          event('turn/start', { turn: 1, trigger: 'prompt' }),
          event('step/start', { turn: 1, step: 1 }),
          event('effect/intent', {
            effectId,
            kind: effectId.startsWith('side:') ? 'side-call' : 'inference',
            replay: effectId.startsWith('side:') ? 'never' : 'safe',
          }),
          ...rows(),
          event('step/end', { turn: 1, step: 1 }),
          event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
        ]
        const root = timelineTrace(await projectUI(events, { sessionKey: `trace-order-${effectId}` }))
        const span = byKind(root, 'generation').find((item) => item.effectId === effectId)
        if (!span) throw new Error('expected a generation span')
        return span
      }

      it('records the failure code and fails an interrupted side call, keeping the cost row duration', async () => {
        const span = await traceOf('side:t', () => [
          sideCost('side:t', { interrupted: true, creditSource: 'estimated' }, { durationMs: 150 }),
          event('effect/settled', {
            effectId: 'side:t',
            outcome: 'error',
            code: 'TIMEOUT',
            durationMs: 200,
          }),
        ])
        expect(span).toMatchObject({
          status: 'failed',
          error: { code: 'TIMEOUT' },
          durationMs: 150,
          purpose: 'side-call',
          model: 'side-model',
        })
      })

      it('fails a side call whose cost row says it finished but whose effect settled as an error', async () => {
        const span = await traceOf('side:e', () => [
          sideCost('side:e'),
          event('effect/settled', { effectId: 'side:e', outcome: 'error', code: 'ADAPTER_ERROR' }),
        ])
        expect(span).toMatchObject({ status: 'failed', error: { code: 'ADAPTER_ERROR' }, durationMs: 30 })
      })

      it('fails a side call on any settled outcome other than ok, with no code to record', async () => {
        for (const outcome of ['error', 'aborted', 'unknown'])
          expect(
            await traceOf(`side:${outcome}`, () => [
              sideCost(`side:${outcome}`),
              event('effect/settled', { effectId: `side:${outcome}`, outcome }),
            ]),
          ).toMatchObject({ status: 'failed', durationMs: 30 })
        const span = await traceOf('side:nocode', () => [
          sideCost('side:nocode'),
          event('effect/settled', { effectId: 'side:nocode', outcome: 'error' }),
        ])
        expect(span).not.toHaveProperty('error')
      })

      it('keeps a completed side call completed when it settled ok', async () => {
        const span = await traceOf('side:ok', () => [
          sideCost('side:ok'),
          event('effect/settled', { effectId: 'side:ok', outcome: 'ok', durationMs: 31 }),
        ])
        expect(span).toMatchObject({ status: 'completed', durationMs: 30 })
        expect(span).not.toHaveProperty('error')
      })

      it('leaves the status of a conversation request alone, whatever its effect settled as', async () => {
        const span = await traceOf('inf-x', () => [
          event('cost/ledger', {
            purpose: 'inference',
            effectId: 'inf-x',
            tokens,
            creditSource: 'estimated',
            model: 'm',
            timing: { durationMs: 8 },
          }),
          event('effect/settled', { effectId: 'inf-x', outcome: 'error' }),
        ])
        expect(span).toMatchObject({ purpose: 'inference', status: 'completed', durationMs: 8 })
        expect(span).not.toHaveProperty('error')
      })
    })

    it('leaves a side call without a settled row running, and closes it as cancelled when aborted', async () => {
      const events = [
        event('turn/start', { turn: 1, trigger: 'prompt' }),
        event('step/start', { turn: 1, step: 1 }),
        event('effect/intent', { effectId: 'side:open', kind: 'side-call', replay: 'never' }),
        event('effect/intent', { effectId: 'side:stop', kind: 'side-call', replay: 'never' }),
        event('effect/settled', { effectId: 'side:stop', outcome: 'aborted', durationMs: 5 }),
      ]
      const root = timelineTrace(await projectUI(events, { sessionKey: 'trace-side-open' }))
      const spans = byKind(root, 'generation')
      expect(spans.find((span) => span.effectId === 'side:open')).toMatchObject({ status: 'running' })
      expect(spans.find((span) => span.effectId === 'side:stop')).toMatchObject({
        status: 'cancelled',
        durationMs: 5,
      })
    })

    it('does not take the request header or send receipt of a conversation request running beside it', async () => {
      const traceId = '12345678-1234-1234-1234-123456789abc'
      const events = [
        event('turn/start', { turn: 1, trigger: 'prompt' }),
        event('step/start', { turn: 1, step: 1 }),
        event('effect/intent', { effectId: 'inf-1', kind: 'inference', replay: 'safe' }),
        event('effect/intent', { effectId: 'side:a', kind: 'side-call', replay: 'never' }),
        event('request/sent', { requestTraceId: traceId }),
        event('request/header', { model: 'main-model' }),
        sideCost('side:a'),
        event('cost/ledger', {
          purpose: 'inference',
          effectId: 'inf-1',
          tokens,
          creditSource: 'estimated',
          model: 'main-model',
          timing: { durationMs: 8 },
        }),
      ]
      const root = timelineTrace(await projectUI(events, { sessionKey: 'trace-side-beside' }))
      const spans = byKind(root, 'generation')
      expect(spans.find((span) => span.effectId === 'inf-1')).toMatchObject({
        model: 'main-model',
        purpose: 'inference',
        requestTraceId: traceId,
      })
      const side = spans.find((span) => span.effectId === 'side:a')
      expect(side).toMatchObject({ model: 'side-model', purpose: 'side-call' })
      expect(side).not.toHaveProperty('requestTraceId')
    })

    it('counts a side call in the turn usage without taking over the final model', async () => {
      const events = [
        event('turn/start', { turn: 1, trigger: 'prompt' }),
        event('step/start', { turn: 1, step: 1 }),
        event('effect/intent', { effectId: 'inf-1', kind: 'inference', replay: 'safe' }),
        event('cost/ledger', {
          purpose: 'inference',
          effectId: 'inf-1',
          tokens,
          credits: 1,
          creditSource: 'gateway',
          model: 'main-model',
          timing: { durationMs: 8 },
        }),
        event('effect/intent', { effectId: 'side:a', kind: 'side-call', replay: 'never' }),
        sideCost('side:a'),
        event('effect/settled', { effectId: 'side:a', outcome: 'ok' }),
        event('step/end', { turn: 1, step: 1 }),
        event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
      ]
      const timeline = await projectUI(events, { sessionKey: 'trace-side-usage' })
      const turn = timeline.turns[0]
      if (!turn) throw new Error('expected one projected turn')
      expect(validateAgainst(UITurnSchema, turn).ok).toBe(true)
      expect(turn.usage.calls.map((call) => [call.id, call.purpose])).toEqual([
        ['inf-1', 'inference'],
        ['side:a', 'side-call'],
      ])
      expect(turn.usage.totals).toEqual({ input: 199, output: 14, cacheRead: 1, cacheWrite: 0, reasoning: 3 })
      expect(turn.usage.credits?.amount).toBe(1.5)
      expect(turn.finalModel).toBe('main-model')
    })
  })
})

function timelineTrace(timeline: { turns: Array<{ trace?: UISpan }> }): UISpan {
  const root = timeline.turns[0]?.trace
  if (!root) throw new Error('expected turn trace')
  return root
}

/** Mutation guard: copying usage tokens onto the turn-root span must fail this assertion. */
it('does not copy usage token totals onto the turn-root span', async () => {
  reset()
  const events = [
    event('turn/start', { turn: 1, trigger: 'prompt' }),
    event('step/start', { turn: 1, step: 1 }),
    event('effect/intent', { effectId: 'inf-1', kind: 'inference', replay: 'safe' }),
    event('cost/ledger', {
      purpose: 'inference',
      effectId: 'inf-1',
      tokens,
      creditSource: 'estimated',
      model: 'm',
      timing: { durationMs: 6 },
    }),
    event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
  ]
  const turn = (await projectUI(events, { sessionKey: 'trace-no-root-tokens' })).turns[0]
  const root = turn?.trace as UISpan & { tokens?: unknown }
  expect(root.tokens).toBeUndefined()
  expect(Object.keys(root)).not.toContain('tokens')
})
