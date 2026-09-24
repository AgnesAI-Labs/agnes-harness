import type { UISpan } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import { UITurn as UITurnSchema } from '@agnes/protocol/gen/agnes-v1'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { traceFold } from '../src/project/trace.js'
import { projectUI } from '../src/project/ui.js'
import type { Event } from '../src/types.js'
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
      event('approval/asked', {
        requestId: 'approval-1',
        kind: 'tool',
        toolUseId: 'tool-1',
        summary: 'run',
        risk: 'always',
        bindingHash: 'a'.repeat(64),
        pending: { ticket: 't1', expiresAt: '2026-09-17T00:10:00.000Z' },
      }),
      event('approval/decided', {
        requestId: 'approval-1',
        toolUseId: 'tool-1',
        verdict: 'rejected',
        via: 'callback',
      }),
      event('step/end', { turn: 1, step: 1 }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const root = timelineTrace(await projectUI(events, { sessionKey: 'trace-approval' }))
    const approval = byKind(root, 'approval')[0]
    const tool = byKind(root, 'tool')[0]
    expect(approval?.status).toBe('failed')
    expect(tool?.status).toBe('failed')
  })

  it('projects approval guardian cost on its approval span and turn call', async () => {
    const events = [
      event('turn/start', { turn: 1, trigger: 'prompt' }),
      event('step/start', { turn: 1, step: 1 }),
      event('effect/intent', {
        effectId: 'guardian-1',
        kind: 'approval-guardian',
        replay: 'never',
        tool: { toolUseId: 'tool-1', name: 'computer_use' },
      }),
      event('effect/settled', { effectId: 'guardian-1', outcome: 'ok', durationMs: 12 }),
      event('cost/ledger', {
        purpose: 'approval-guardian',
        effectId: 'guardian-1',
        tokens: { input: 1024, output: 0, cacheRead: 0, cacheWrite: 0 },
        credits: 0.5,
        creditSource: 'gateway',
        model: 'guardian-model',
      }),
      event('step/end', { turn: 1, step: 1 }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const timeline = await projectUI(events, { sessionKey: 'trace-guardian' })
    const approval = byKind(timelineTrace(timeline), 'approval')[0]
    expect(approval).toMatchObject({
      effectId: 'guardian-1',
      purpose: 'approval-guardian',
      model: 'guardian-model',
      callSeq: events[4]?.seq,
      status: 'completed',
    })
    expect(timeline.turns[0]?.usage.calls).toEqual([
      expect.objectContaining({
        id: 'guardian-1',
        purpose: 'approval-guardian',
        credits: 0.5,
        model: 'guardian-model',
      }),
    ])
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
