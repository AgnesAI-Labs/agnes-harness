import { readFileSync } from 'node:fs'
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
  it('renders actual Host nested calls under their root in conversation and trace, with causal evidence', async () => {
    const capture = JSON.parse(
      readFileSync('packages/host/test/fixtures/jev-nested-host-read-write-read.json', 'utf8'),
    ) as { events: Event[] }
    const journal = capture.events.filter((row) => row.type === 'x/host/jev-nested')
    const first = journal[0]
    if (!first) throw new Error('Missing actual nested journal')
    const binding = (first.data as { binding: { sessionKey: string; rootIntentId: string } }).binding
    const timeline = await projectUI(capture.events, { sessionKey: binding.sessionKey })
    const tools = timeline.nodes.filter((node) => node.kind === 'tool')
    const root = tools.find((node) => node.toolUseId === binding.rootIntentId)
    if (!root) throw new Error('Missing actual root tool')
    const nested = tools.filter((node) => node !== root)
    expect(nested.map((node) => node.name)).toEqual(['read', 'write', 'read'])
    expect(nested.map((node) => node.depth)).toEqual([1, 1, 1])
    expect(root.children).toEqual(nested.map((node) => node.id))
    const trace = timeline.turns[0]?.trace
    if (!trace) throw new Error('Missing actual turn trace')
    const rootSpan = byKind(trace, 'tool').find((span) => span.toolUseId === root.toolUseId)
    if (!rootSpan) throw new Error('Missing root tool span')
    expect(rootSpan.children.map((span) => span.toolUseId)).toEqual(nested.map((node) => node.toolUseId))
    expect(byKind(trace, 'tool')).toHaveLength(4)
    for (const corrupt of ['untrusted', 'source', 'parent'] as const) {
      const rows = structuredClone(capture.events)
      for (const row of rows.filter((entry) => entry.type === 'x/host/jev-nested')) {
        if (corrupt === 'untrusted') row.trust = 'untrusted'
        if (corrupt === 'source') row.sourceEventSeqs = []
        if (corrupt === 'parent')
          (row.data as { binding: { parentToolUseId: string } }).binding.parentToolUseId = 'unrelated'
      }
      const invalid = await projectUI(rows, { sessionKey: binding.sessionKey })
      expect(
        invalid.nodes.filter((node) => node.kind === 'tool').every((node) => node.depth === undefined),
      ).toBe(true)
      const invalidTrace = invalid.turns[0]?.trace
      if (!invalidTrace) throw new Error('Malformed presentation evidence must retain the tool trace')
      expect(
        byKind(invalidTrace, 'tool').find((span) => span.toolUseId === root.toolUseId)?.children,
      ).toEqual([])
    }
  })

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

it('rehydrates runtime request metadata without duplicating titles before late settlement and routing', async () => {
  seq = 0
  const runtime = { id: 'jevloop', version: '1' }
  const work = (record: Record<string, unknown>) =>
    event('runtime/record', {
      runtime,
      record: { version: 1, turn: 'run', ...record },
    } as Event['data'])
  const rows = [
    event('turn/start', { turn: 1, trigger: 'prompt' }),
    work({
      id: 'request',
      kind: 'model.requested',
      call: { purpose: 'decision', requestedModel: 'model-a', input: {} },
    }),
    event('turn/end', { reason: 'blocked', lastAssistantSeq: null }),
    work({
      id: 'settled',
      kind: 'model.settled',
      requested: 'request',
      settlement: { output: { scores: {} } },
    }),
    work({
      id: 'selected',
      kind: 'decision.selected',
      requested: 'request',
      phase: 'INSPECT',
      operation: 'read',
    }),
  ]
  const view = await projectUI(rows, { sessionKey: 'runtime-hydrate' })
  const spans = view.turns[0]?.trace?.children[0]?.children ?? []
  expect(spans).toHaveLength(1)
  expect(spans[0]).toMatchObject({
    kind: 'runtime',
    runtime,
    model: 'model-a',
    runtimeTitle: '决策模型',
    runtimePurpose: 'decision',
    name: '决策模型 · 采用路径：INSPECT → read',
    status: 'completed',
    nodeIds: ['runtime:2'],
  })
  const checked = validateAgainst(UITurnSchema, view.turns[0])
  expect(checked.ok ? [] : checked.errors).toEqual([])
})
