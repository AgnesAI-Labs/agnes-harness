import type { UINode, UISpan, UITurn } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { buildTraceRows } from '../src/trace.js'

/**
 * The trace list's per-node lookups, as they were before the index: linear scans in turn order and
 * DFS order. The indexed build must give the same answer for every node, including the corner cases
 * the scans resolve by "first match wins".
 */
function legacyTurnFor(
  node: Exclude<UINode, { kind: 'slot' }>,
  turns: readonly UITurn[],
): UITurn | undefined {
  const owned = turns.find((turn) => turn.nodeIds.includes(node.id))
  if (owned) return owned
  return turns.find(
    (turn) => node.seq >= turn.startSeq && (turn.endSeq === undefined || node.seq <= turn.endSeq),
  )
}

function legacySpanFor(node: UINode, turns: readonly UITurn[]): UISpan | undefined {
  let found: UISpan | undefined
  const walk = (span: UISpan): void => {
    if (found) return
    if (span.nodeIds?.includes(node.id)) found = span
    else if (node.kind === 'tool' && span.toolUseId === node.toolUseId) found = span
    for (const child of span.children) walk(child)
  }
  for (const turn of turns) {
    if (turn.trace) walk(turn.trace)
    if (found) return found
  }
  return found
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STATUSES = ['running', 'waiting', 'completed', 'failed', 'cancelled'] as const

function fixture(seed: number, nodeCount = 40, turnCount = 6) {
  const rand = mulberry32(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
  const nodes: UINode[] = []
  for (let i = 0; i < nodeCount; i++) {
    const seq = i + 1
    const id = `n${i}`
    const kind = pick(['user', 'assistant', 'tool', 'context', 'approval'] as const)
    if (kind === 'tool')
      nodes.push({
        kind,
        id,
        seq,
        toolUseId: `call-${Math.floor(rand() * 8)}`,
        name: 'read',
        status: 'completed',
        summary: 's',
        enforcement: { level: 'full', scope: [] },
        children: [],
      } as UINode)
    else if (kind === 'user')
      nodes.push({ kind, id, seq, content: [{ type: 'text', text: `u ${id}` }] } as UINode)
    else if (kind === 'approval') nodes.push({ kind, id, seq, summary: `approve ${id}` } as unknown as UINode)
    else nodes.push({ kind, id, seq, text: `${kind} ${id}` } as UINode)
  }
  let spanId = 0
  const span = (depth: number): UISpan => ({
    id: `s${spanId++}`,
    kind: pick(['generation', 'tool', 'step', 'other'] as const),
    name: 'x',
    status: pick(STATUSES),
    startSeq: 1,
    startedAt: '2026-09-17T00:00:00.000Z',
    ...(rand() < 0.7 ? { durationMs: Math.floor(rand() * 500) } : {}),
    ...(rand() < 0.3 ? { ttftMs: Math.floor(rand() * 50) } : {}),
    ...(rand() < 0.4 ? { model: pick(['m1', 'm2']) } : {}),
    ...(rand() < 0.5 ? { toolUseId: `call-${Math.floor(rand() * 8)}` } : {}),
    ...(rand() < 0.6
      ? {
          nodeIds: Array.from(
            { length: 1 + Math.floor(rand() * 3) },
            () => `n${Math.floor(rand() * nodeCount)}`,
          ),
        }
      : {}),
    children: depth < 3 ? Array.from({ length: Math.floor(rand() * 3) }, () => span(depth + 1)) : [],
  })
  const turns: UITurn[] = []
  for (let t = 0; t < turnCount; t++) {
    const startSeq = 1 + Math.floor(rand() * nodeCount)
    turns.push({
      id: `turn:${t}`,
      turn: t + 1,
      startSeq,
      // Several open-ended turns and overlapping ranges on purpose.
      ...(rand() < 0.6 ? { endSeq: startSeq + Math.floor(rand() * 15) } : {}),
      startedAt: '2026-09-17T00:00:00.000Z',
      status: pick(STATUSES),
      // Some nodes belong to no turn's nodeIds at all.
      nodeIds: Array.from(
        { length: Math.floor(rand() * 8) },
        () => `n${Math.floor(rand() * (nodeCount - 5))}`,
      ),
      inherited: false,
      forkable: true,
      ...(rand() < 0.8 ? { trace: span(0) } : {}),
    } as unknown as UITurn)
  }
  return { nodes, turns }
}

describe('indexed trace rows', () => {
  it('match the linear per-node lookups on random fixtures', () => {
    let rows = 0
    for (let seed = 1; seed <= 300; seed++) {
      const { nodes, turns } = fixture(seed)
      const built = buildTraceRows(nodes, turns)
      const byId = new Map(built.map((row) => [row.id, row]))
      for (const node of nodes) {
        const row = byId.get(node.id)
        if (!row || node.kind === 'slot') continue
        rows++
        const span = legacySpanFor(node, turns)
        expect(row.turn, `seed ${seed} ${node.id}`).toBe(legacyTurnFor(node, turns)?.turn)
        expect(row.durationMs, `seed ${seed} ${node.id}`).toBe(span?.durationMs)
        expect(row.ttftMs, `seed ${seed} ${node.id}`).toBe(span?.ttftMs)
        expect(row.model, `seed ${seed} ${node.id}`).toBe(span?.model)
      }
    }
    expect(rows).toBeGreaterThan(5000)
  })

  it('prefers the earlier span when a node matches one span by id and another by tool use', () => {
    const tool = {
      kind: 'tool',
      id: 't',
      seq: 1,
      toolUseId: 'call',
      name: 'read',
      status: 'completed',
      summary: 's',
      enforcement: { level: 'full', scope: [] },
      children: [],
    } as UINode
    const leaf = (id: string, extra: Partial<UISpan>): UISpan =>
      ({
        id,
        kind: 'tool',
        name: id,
        status: 'completed',
        startSeq: 1,
        startedAt: '2026-09-17T00:00:00.000Z',
        children: [],
        ...extra,
      }) as UISpan
    const byToolUseFirst = [
      {
        id: 'turn:1',
        turn: 1,
        startSeq: 1,
        nodeIds: [],
        trace: {
          ...leaf('root', {}),
          children: [
            leaf('a', { toolUseId: 'call', model: 'first' }),
            leaf('b', { nodeIds: ['t'], model: 'second' }),
          ],
        },
      },
    ] as unknown as UITurn[]
    expect(buildTraceRows([tool], byToolUseFirst)[0]?.model).toBe('first')
    const byIdFirst = [
      {
        id: 'turn:1',
        turn: 1,
        startSeq: 1,
        nodeIds: [],
        trace: {
          ...leaf('root', {}),
          children: [
            leaf('b', { nodeIds: ['t'], model: 'second' }),
            leaf('a', { toolUseId: 'call', model: 'first' }),
          ],
        },
      },
    ] as unknown as UITurn[]
    expect(buildTraceRows([tool], byIdFirst)[0]?.model).toBe('second')
  })

  it('reads each node, nodeId and span a bounded number of times on a large snapshot', () => {
    const counter = { reads: 0 }
    const counted = <T>(items: T[]): T[] =>
      new Proxy(items, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) counter.reads++
          return Reflect.get(target, key, receiver)
        },
      })
    const N = 3000
    const S = 6000
    const nodes: UINode[] = Array.from(
      { length: N },
      (_, i) => ({ kind: 'assistant', id: `n${i}`, seq: i + 1, text: 'x' }) as UINode,
    )
    const T = 30
    let made = 0
    const spansPerTurn = S / T
    const turns: UITurn[] = Array.from({ length: T }, (_, t) => {
      const children: UISpan[] = []
      for (let k = 0; k < spansPerTurn - 1; k++) {
        const nodeId = `n${(made++ * 7) % N}`
        children.push({
          id: `s${t}-${k}`,
          kind: 'generation',
          name: 'g',
          status: 'completed',
          startSeq: 1,
          startedAt: '2026-09-17T00:00:00.000Z',
          nodeIds: counted([nodeId]),
          children: counted([]),
        } as UISpan)
      }
      const owned = Array.from({ length: (N - 300) / T }, (_, k) => `n${t * ((N - 300) / T) + k}`)
      return {
        id: `turn:${t}`,
        turn: t + 1,
        startSeq: 1,
        nodeIds: counted(owned),
        trace: {
          id: `root-${t}`,
          kind: 'turn',
          name: 't',
          status: 'completed',
          startSeq: 1,
          startedAt: '2026-09-17T00:00:00.000Z',
          children: counted(children),
        },
      } as unknown as UITurn
    })
    const sumNodeIds = turns.reduce((n, turn) => n + turn.nodeIds.length, 0)
    const unowned = 300
    const rows = buildTraceRows(counted(nodes), counted(turns))
    expect(rows).toHaveLength(N)
    expect(counter.reads).toBeLessThanOrEqual(2 * (N + sumNodeIds + S) + unowned * T)
  })
})
