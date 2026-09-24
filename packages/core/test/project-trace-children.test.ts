import type { ModelRecord, UISpan, UITurn, UITurnUsage } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { attachChildTraces } from '../src/project/trace.js'
import { projectUI } from '../src/project/ui.js'
import { presetDefaults } from '../src/step/preset.js'
import type { Event, EventInput } from '../src/types.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const tokens = { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
const enforcement = { level: 'full' as const, scope: ['process' as const] }
const emptyTotals = (): UITurnUsage['totals'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
})

let seq = 0
const event = (type: string, data: Event['data']): Event => {
  seq += 1
  return {
    seq,
    ts: new Date(Date.UTC(2026, 8, 17, 1, 0, seq)).toISOString(),
    id: `01K0000000000000000001${String(seq).padStart(4, '0')}`,
    type,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
  }
}

const spawnTool = (toolUseId: string, childKey: string): Event[] => [
  event('tool/call', { toolUseId, name: 'subagent_spawn', args: { task: childKey }, ordinal: 0 }),
  event('effect/intent', {
    effectId: `eff-${toolUseId}`,
    kind: 'tool',
    replay: 'never',
    tool: { toolUseId, name: 'subagent_spawn' },
  }),
  event('effect/settled', { effectId: `eff-${toolUseId}`, outcome: 'ok', durationMs: 7 }),
  event('tool/result', {
    toolUseId,
    content: [{ type: 'text', text: `spawned ${childKey}` }],
    structured: { childKey },
    isError: false,
    enforcement,
    authz: { decisionId: `d-${toolUseId}` },
  }),
]

const childRoot = (id: string, name: string): UISpan => ({
  id,
  kind: 'turn',
  name,
  status: 'completed',
  startSeq: 1,
  startedAt: '2026-09-17T01:00:00.000Z',
  children: [
    {
      id: `${id}:gen`,
      kind: 'generation',
      name: 'child-model',
      status: 'completed',
      startSeq: 2,
      startedAt: '2026-09-17T01:00:01.000Z',
      durationMs: 11,
      children: [],
    },
  ],
})

describe('subagent span binding', () => {
  it('binds two concurrent spawns to matching child keys and keeps spawn containers open', async () => {
    seq = 0
    const events = [
      event('turn/start', { turn: 1, trigger: 'prompt' }),
      event('step/start', { turn: 1, step: 1 }),
      ...spawnTool('spawn-a', 'child-a'),
      ...spawnTool('spawn-b', 'child-b'),
      event('step/end', { turn: 1, step: 1 }),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const timeline = await projectUI(events, { sessionKey: 'parent-trace' })
    const tools =
      timeline.turns[0]?.trace?.children[0]?.children.filter((child) => child.kind === 'tool') ?? []
    expect(tools).toHaveLength(2)
    const nested = tools.map((tool) => tool.children.find((child) => child.kind === 'subagent'))
    expect(nested[0]?.childSessionKey).toBe('child-a')
    expect(nested[1]?.childSessionKey).toBe('child-b')
    expect(nested[0]?.status).toBe('running')
    expect(nested[1]?.status).toBe('running')
    expect(nested[0]?.children).toEqual([])
  })

  it('attaches child trees by exact key and leaves parent usage totals unchanged', async () => {
    seq = 0
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
        timing: { durationMs: 5 },
      }),
      ...spawnTool('spawn-a', 'child-a'),
      ...spawnTool('spawn-b', 'child-b'),
      event('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ]
    const timeline = await projectUI(events, { sessionKey: 'parent-attach' })
    const before = structuredClone(timeline.turns[0]?.usage.totals)
    const loads: string[] = []
    await attachChildTraces(
      timeline.turns,
      async (key) => {
        loads.push(key)
        if (key === 'child-a') return [childRoot('turn:1', 'child-a')]
        if (key === 'child-b') return [childRoot('turn:1', 'child-b')]
        return undefined
      },
      timeline.turns[0]?.usage.totals ?? emptyTotals(),
    )
    expect(loads.sort()).toEqual(['child-a', 'child-b'])
    expect(timeline.turns[0]?.usage.totals).toEqual(before)
    const tools = (timeline.turns[0]?.trace?.children[0]?.children ?? []).filter(
      (child) => child.kind === 'tool',
    )
    const nestedA = tools
      .flatMap((tool) => tool.children)
      .find((child) => child.childSessionKey === 'child-a')
    const nestedB = tools
      .flatMap((tool) => tool.children)
      .find((child) => child.childSessionKey === 'child-b')
    expect(nestedA?.children[0]?.name).toBe('child-a')
    expect(nestedB?.children[0]?.name).toBe('child-b')
    expect(nestedA?.children[0]?.children[0]?.kind).toBe('generation')
  })

  it('keeps a stub when load throws and does not recurse on cycles', async () => {
    const turn: UITurn = {
      id: 'turn:1',
      turn: 1,
      startSeq: 1,
      startedAt: '2026-09-17T00:00:00.000Z',
      status: 'completed',
      nodeIds: [],
      usage: {
        totals: emptyTotals(),
        reasoningComplete: false,
        billingComplete: false,
        calls: [],
      },
      inherited: false,
      forkable: false,
      trace: {
        id: 'turn:1',
        kind: 'turn',
        name: 'Turn 1',
        status: 'completed',
        startSeq: 1,
        startedAt: '2026-09-17T00:00:00.000Z',
        children: [
          {
            id: 'span:subagent:loop',
            kind: 'subagent',
            name: 'subagent_spawn',
            status: 'running',
            startSeq: 2,
            startedAt: '2026-09-17T00:00:01.000Z',
            childSessionKey: 'loop-child',
            children: [],
          },
        ],
      },
    }
    let calls = 0
    await attachChildTraces(
      [turn],
      async () => {
        calls += 1
        throw new Error('unreadable')
      },
      emptyTotals(),
    )
    expect(calls).toBe(1)
    expect(turn.trace?.children[0]?.childSessionKey).toBe('loop-child')
    expect(turn.trace?.children[0]?.children).toEqual([])

    calls = 0
    const cyclic: UITurn = structuredClone(turn)
    await attachChildTraces(
      [cyclic],
      async (key) => {
        calls += 1
        return [
          {
            id: 'turn:1',
            kind: 'turn',
            name: 'loop',
            status: 'completed',
            startSeq: 1,
            startedAt: '2026-09-17T00:00:00.000Z',
            children: [
              {
                id: 'span:subagent:again',
                kind: 'subagent',
                name: 'subagent_spawn',
                status: 'running',
                startSeq: 2,
                startedAt: '2026-09-17T00:00:01.000Z',
                childSessionKey: key,
                children: [],
              },
            ],
          },
        ]
      },
      emptyTotals(),
    )
    expect(calls).toBe(1)
  })
})

const catalogue = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

describe('SessionImpl.projectUI nests child traces via bounded storage.scan', () => {
  const kernels: Kernel[] = []
  afterEach(async () => {
    for (const k of kernels.splice(0)) await k.close()
  })

  it('scans the child from boundarySeq+1 with a limit and nests its generation under the matching subagent', async () => {
    const storage = new MemoryStorage()
    const scan = vi.spyOn(storage, 'scan')
    const k = Kernel.create({
      storage,
      seams: fakeSeams(),
      provider: Object.assign(fakeProvider([textTurn('child says hi')]), { models: () => [catalogue()] }),
      contract: { contract_id: null, parser_version: '1' },
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 2 },
      fsOps: testFsOps(),
      netFetch: async () => new Response(''),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      timers: noTimers,
      clock: () => 1_757_203_200_000,
    })
    kernels.push(k)
    const parent = await k.session('parent', {
      actor,
      resolvedProfileHash: 'h1',
      cwd: '/w',
      writerRunId: 'r1',
    })
    if (!parent.d.children.createWithKind) throw new Error('kernel child factory must expose createWithKind')
    const handle = await parent.d.children.createWithKind('spawn', {
      parent: parent.key,
      cwd: '/w',
      input: 'child work',
    })
    await handle.run('child work')
    const record = await storage.lookupByKey(handle.key)
    if (!record) throw new Error('expected child control record')

    const row = (type: string, data: EventInput['data']): EventInput => ({
      type,
      data,
      actor,
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
    })
    scan.mockClear()
    await parent.d.log.append([
      row('turn/start', { turn: 1, trigger: 'prompt' }),
      row('step/start', { turn: 1, step: 1 }),
      row('tool/call', {
        toolUseId: 'spawn-1',
        name: 'subagent_spawn',
        args: { task: 'child work' },
        ordinal: 0,
      }),
      row('effect/intent', {
        effectId: 'eff-spawn-1',
        kind: 'tool',
        replay: 'never',
        tool: { toolUseId: 'spawn-1', name: 'subagent_spawn' },
      }),
      row('effect/settled', { effectId: 'eff-spawn-1', outcome: 'ok', durationMs: 7 }),
      row('tool/result', {
        toolUseId: 'spawn-1',
        content: [{ type: 'text', text: `spawned ${handle.key}` }],
        structured: { childKey: handle.key },
        isError: false,
        enforcement: { level: 'full', scope: ['process'] },
        authz: { decisionId: 'd-spawn-1' },
      }),
      row('step/end', { turn: 1, step: 1 }),
      row('turn/end', { reason: 'completed', lastAssistantSeq: null }),
    ])

    scan.mockClear()
    const timeline = await parent.projectUI()
    const childScans = scan.mock.calls.filter((call) => call[0] === handle.key)
    expect(childScans.length).toBeGreaterThan(0)
    for (const [, query] of childScans) {
      expect(query.limit).toBe(500)
      expect(query.fromSeq).toBe(record.boundarySeq + 1)
      expect(query.toSeq === undefined || query.limit !== undefined).toBe(true)
    }
    const nested = timeline.turns
      .flatMap((turn) => (turn.trace ? [turn.trace] : []))
      .flatMap(function walk(span: UISpan): UISpan[] {
        return [span, ...span.children.flatMap(walk)]
      })
      .find((span) => span.kind === 'subagent' && span.childSessionKey === handle.key)
    expect(nested).toBeDefined()
    const generations = (nested?.children ?? []).flatMap(function walk(span: UISpan): UISpan[] {
      return span.kind === 'generation' ? [span] : span.children.flatMap(walk)
    })
    expect(generations.length).toBeGreaterThan(0)
    expect(
      timeline.turns[0]?.usage.calls.every(
        (call) => call.purpose !== 'inference' || call.id !== generations[0]?.effectId,
      ),
    ).toBe(true)
  })
})
