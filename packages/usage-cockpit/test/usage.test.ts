import type { UINode, UITimeline, UITurn, UITurnCall } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { catalog } from '../src/locales.js'
import { SelectedUsage, usageSnapshot } from '../src/model.js'

const cost = (
  id: string,
  purpose: string,
  billing?: { usdMicros: number; source: 'gateway' | 'estimated'; subscription: boolean },
): UINode => ({
  kind: 'cost',
  id,
  seq: Number(id.replace(/\D/g, '')) || 1,
  purpose,
  model: 'fake-model',
  source: 'estimated',
  tokens: { input: 10, output: 2, cacheRead: 4, cacheWrite: 0 },
  ...(billing ? { billing } : {}),
})
const asTurn = (calls: UITurnCall[], inherited = false): UITurn => ({
  id: 'turn-1',
  turn: 1,
  startSeq: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  status: 'completed',
  nodeIds: [],
  inherited,
  forkable: false,
  usage: {
    totals: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: false,
    billingComplete: false,
    calls,
  },
})
const asCall = (node: UINode): UITurnCall => {
  if (node.kind !== 'cost') throw new Error('Expected synthetic cost')
  return {
    ...node,
    id: node.id,
    purpose: node.purpose as UITurnCall['purpose'],
    model: node.model ?? 'fake-model',
    creditSource: node.source,
  }
}
const timeline = (nodes: UINode[] = [], sessionId = 'synthetic-selected'): UITimeline => ({
  sessionId,
  generation: 1,
  opState: null,
  upto: 9,
  nodes,
  turns: [asTurn(nodes.map(asCall))],
  slots: [],
  usage: {
    totals: { input: 20, output: 4, cacheRead: 8, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: false,
    billingComplete: false,
    cost: { usdMicros: 150, source: 'estimated', subscription: false },
    context: { source: 'estimated', tokens: 100, window: 1000, autoCompact: true },
    model: { route: 'fake-route', id: 'fake-model', thinking: 'off' },
  },
})

describe('selected-session display projection', () => {
  it('keeps canonical adjusted totals separate from duplicate observed calls, late charges and unknown costs', () => {
    const actual = cost('c1', 'inference', { usdMicros: 100, source: 'gateway', subscription: false })
    const estimated = {
      ...cost('c2', 'side-call', { usdMicros: 80, source: 'estimated', subscription: false }),
      interrupted: true,
    }
    const child = cost('c3', 'subagent')
    const adjustment: UINode = {
      kind: 'cost',
      id: 'a4',
      seq: 4,
      source: 'estimated',
      purpose: 'inference',
      model: 'fake-model',
    }
    const source = timeline([actual, actual, estimated, child, adjustment])
    const calls = source.turns[0]?.usage.calls
    if (!calls) throw new Error('Missing fixture calls')
    calls[calls.length - 1] = {
      ...asCall(adjustment),
      adjustment: { of: 1, delta: -0.03, usdMicrosDelta: -30, reason: 'synthetic refund' },
    }
    source.nodes.push({ ...actual, id: 'duplicate8', seq: 8 })
    calls.push({ ...asCall(actual), seq: 8 })
    const snapshot = usageSnapshot(source)
    expect(snapshot.usage?.cost?.usdMicros).toBe(150)
    expect(snapshot.groups.find((group) => group.name === 'primary')?.rows).toHaveLength(1)
    expect(snapshot.observed).toEqual({
      actual: 70,
      estimated: 80,
      unknown: 1,
      unattributed: 0,
      adjustments: 1,
    })
    expect(snapshot.groups.find((group) => group.name === 'child')?.rows).toEqual([asCall(child)])
    expect(snapshot.groups.find((group) => group.name === 'side-call')?.rows[0]?.interrupted).toBe(true)
    expect(usageSnapshot(structuredClone(source))).toEqual(snapshot)
    expect(source.turns[0]?.usage.calls[0]?.billing?.usdMicros).toBe(100)
    const cumulative = structuredClone(source)
    if (!cumulative.usage) throw new Error('Missing synthetic totals')
    cumulative.usage.model = { ...cumulative.usage.model, id: 'fake-replacement', route: 'fake-new-route' }
    cumulative.usage.totals.input = 75
    cumulative.usage.cost = { usdMicros: 450, source: 'estimated', subscription: false }
    expect(usageSnapshot(cumulative).usage?.totals.input).toBe(75)
    expect(usageSnapshot(cumulative).usage?.cost?.usdMicros).toBe(450)
    expect(usageSnapshot(structuredClone(cumulative))).toEqual(usageSnapshot(cumulative))
    const inherited = timeline([child])
    if (inherited.turns[0]) inherited.turns[0].inherited = true
    expect(usageSnapshot(inherited).groups.find((group) => group.name === 'child')?.rows).toEqual([])
    const rerouted = timeline([
      ...source.nodes,
      { ...cost('c5', 'compaction'), model: 'fake-summary' },
      cost('c6', 'approval-guardian'),
    ])
    expect(usageSnapshot(rerouted).groups.find((group) => group.name === 'summary')?.rows[0]?.model).toBe(
      'fake-summary',
    )
    expect(usageSnapshot(rerouted).groups.find((group) => group.name === 'reviewer')?.rows).toHaveLength(1)
  })

  it('does not synthesize billing or usage for older projections', () => {
    const { usage: _, turns: _turns, ...old } = timeline()
    const result = usageSnapshot({ ...old, nodes: [cost('unknown9', 'inference')] })
    expect(result.usage).toBeUndefined()
    expect(result.observed.unattributed).toBe(1)
    expect(result.observed.actual).toBeUndefined()
    expect(result.observed.estimated).toBeUndefined()
    expect(result.groups.every((group) => group.rows.length === 0)).toBe(true)
  })

  it('reads only the selected authorized projection, drops stale results and refuses mismatched sessions', async () => {
    const collector = new SelectedUsage()
    let finish!: (value: UITimeline) => void
    const pending = collector.read(
      'old',
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const selected = await collector.read('selected', async () => timeline([], 'selected'))
    finish(timeline([], 'old'))
    expect(await pending).toBeUndefined()
    expect(selected?.sessionId).toBe('selected')
    await expect(collector.read('selected', async () => timeline([], 'foreign'))).rejects.toThrow(
      'Session selection changed',
    )
    await expect(
      collector.read('selected', async () => {
        throw new Error('denied')
      }),
    ).rejects.toThrow('denied')
    expect((await collector.read('selected', async () => timeline([], 'selected')))?.sessionId).toBe(
      'selected',
    )
    collector.dispose()
    expect(
      await collector.read('selected', async () => {
        throw new Error('Disposed collector read again')
      }),
    ).toBeUndefined()
  })

  it('ships matching English and Chinese strings with explicit scope and unknown attribution', () => {
    expect(Object.keys(catalog.en).sort()).toEqual(Object.keys(catalog['zh-CN']).sort())
    for (const locale of Object.values(catalog)) {
      expect(locale['usage.gap']).toBeTruthy()
      expect(locale['usage.unknown']).toBeTruthy()
      expect(locale['usage.attribution']).toBeTruthy()
    }
  })
})
