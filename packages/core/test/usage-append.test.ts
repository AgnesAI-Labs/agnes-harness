import { describe, expect, it } from 'vitest'
import { applyCacheHealthEvent, initialCacheHealthState } from '../src/project/cache-health.js'
import { computeSurface, SurfaceCache } from '../src/project/surface.js'
import { UIProjectionCell } from '../src/project/ui.js'
import type { Event } from '../src/types.js'
import { TRANSITION_SCENARIOS } from '../testkit/record-transitions.js'
import { goldenLedger, toolHeavyLedger } from '../testkit/tool-heavy-ledger.js'
import { copiedPerRow } from './helpers/copy-counter.js'
import {
  plainCacheHealthState,
  referenceApplyCacheHealthEvent,
  referenceApplyEvent,
  referenceComputeSurface,
  referenceInitialCacheHealthState,
} from './helpers/reference-usage.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

/** Cost and header rows that reach every branch of the cache-health fold: repeats, interrupted and
 * adjusted rows, other lanes, a warm cache going cold, compaction in between, and a fork start. */
function* cacheRows(): Generator<Event> {
  let seq = 0
  let x = 9
  const random = () => {
    x = (x * 48_271) % 2_147_483_647
    return x / 2_147_483_647
  }
  const at = (type: string, data: unknown, extra: Partial<Event> = {}): Event =>
    ({
      seq: ++seq,
      ts: '2025-09-07T00:00:00.000Z',
      id: `c${seq}`,
      type,
      lane: 'main',
      v: 1,
      actor,
      origin: 'system',
      trust: 'trusted',
      data,
      ...extra,
    }) as Event
  const sent: Event[] = []
  for (let n = 0; n < 600; n++) {
    const pick = random()
    if (pick < 0.1) yield at('request/header', { prompt_prefix_hash: `p${Math.floor(random() * 3)}` })
    else if (pick < 0.13)
      yield at('assistant/message', { content: [] }, {
        surfaceOp: { op: 'replace', start: 1, end: 2 },
      } as Partial<Event>)
    else if (pick < 0.2 && sent.length > 0)
      yield { ...(sent[Math.floor(random() * sent.length)] as Event), seq: ++seq }
    else if (pick < 0.21) yield at('session/start', { key: 'k', parent: { key: 'p', boundarySeq: seq } })
    else {
      const warm = random() < 0.5
      const row = at(
        'cost/ledger',
        {
          purpose: random() < 0.9 ? 'inference' : 'title',
          effectId: `e${n}`,
          tokens: { input: warm ? 100 : 3000, output: 5, cacheRead: warm ? 4000 : 0, cacheWrite: 10 },
          creditSource: 'gateway',
          model: 'm',
          ...(random() < 0.05 ? { interrupted: true } : {}),
          ...(random() < 0.05 ? { adjustment: { of: 1, delta: 1 } } : {}),
        },
        random() < 0.1 ? { lane: 'side' } : {},
      )
      sent.push(row)
      yield row
    }
  }
}

/** A surface that is compacted twice, the second summary covering the first, with rows between. */
function* compactedRows(): Generator<Event> {
  let seq = 0
  const at = (type: string, extra: Partial<Event> = {}): Event =>
    ({
      seq: ++seq,
      ts: '2025-09-07T00:00:00.000Z',
      id: `s${seq}`,
      type,
      lane: 'main',
      v: 1,
      actor,
      origin: 'system',
      trust: 'trusted',
      data: { content: [{ type: 'text', text: `row ${seq}` }] },
      ...extra,
    }) as Event
  let summary = 0
  for (let round = 0; round < 3; round++) {
    const first = seq + 1
    yield at('user/message')
    yield at('assistant/message')
    yield at('effect/settled', { data: { effectId: `x${seq}` } })
    yield at('tool/result')
    yield at('user/message')
    const end = seq
    // Round 0 summarizes its own rows; later rounds start at the previous summary and cover it.
    const start = round === 0 ? first : summary
    yield at('assistant/message', {
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [start, end],
    } as Partial<Event>)
    summary = seq
  }
}

const crashFree = TRANSITION_SCENARIOS.map((name) => [`golden ${name}`, () => goldenLedger(name)] as const)
const sources: (readonly [string, () => Iterable<Event>])[] = [
  ...crashFree,
  ['300 tool calls', () => toolHeavyLedger({ calls: 300 })],
  ['cache-health branches', () => cacheRows()],
  ['compacted surface', () => compactedRows()],
]

describe('cache health, with its seen set chunked', () => {
  it.each(sources)('matches the reference row for row: %s', (_name, rows) => {
    let ours = initialCacheHealthState()
    let theirs = referenceInitialCacheHealthState()
    for (const row of rows()) {
      const before = JSON.stringify(plainCacheHealthState(ours))
      const prev = ours
      ours = applyCacheHealthEvent(ours, row, 'main')
      theirs = referenceApplyCacheHealthEvent(theirs, row, 'main')
      expect(plainCacheHealthState(ours), `row ${row.seq}`).toEqual(plainCacheHealthState(theirs as never))
      // The state it was given is left as it was.
      expect(JSON.stringify(plainCacheHealthState(prev))).toBe(before)
    }
  })
})

describe('the surface, appended in place', () => {
  it.each(sources)('matches the reference row for row: %s', { timeout: 60_000 }, (_name, rows) => {
    const cache = new SurfaceCache('main')
    let reference: ReturnType<typeof referenceComputeSurface> = []
    const all: Event[] = []
    for (const row of rows()) {
      all.push(row)
      cache.push([row])
      if ((row.lane ?? 'main') === 'main') reference = referenceApplyEvent(reference, row, new Set()).nodes
      expect(cache.nodes(), `row ${row.seq}`).toEqual(reference)
    }
    expect(computeSurface(all)).toEqual(referenceComputeSurface(all))
    expect(computeSurface(all, { upto: Math.floor(all.length / 2) })).toEqual(
      referenceComputeSurface(all, { upto: Math.floor(all.length / 2) }),
    )
  })

  it('never changes an array it handed out, and hands out the same one until something changes', () => {
    const rows = [...compactedRows()]
    const cache = new SurfaceCache('main')
    const held: { nodes: readonly unknown[]; copy: string }[] = []
    for (const row of rows) {
      const before = cache.nodes()
      cache.push([row])
      const after = cache.nodes()
      const surfaceRow = ['user/message', 'assistant/message', 'tool/result'].includes(row.type)
      if (!surfaceRow) expect(after, `row ${row.seq} is not a surface row`).toBe(before)
      held.push({ nodes: after, copy: JSON.stringify(after) })
    }
    const last = cache.nodes()
    const first = last[0] as { seq: number } | undefined
    if (first) cache.pin(first.seq)
    expect(cache.nodes()).not.toBe(last)
    expect(cache.snapshot().nodes).toBe(cache.nodes())
    for (const { nodes, copy } of held) expect(JSON.stringify(nodes)).toBe(copy)
    expect(cache.replaceGeneration).toBe(3)
  })
})

describe('what building a UI cell of a long tool-heavy session copies', () => {
  it('copies a bounded number of entries per row, however many calls came before', {
    timeout: 120_000,
  }, () => {
    const perRow = copiedPerRow(toolHeavyLedger({ calls: 4000 }), (rows) => {
      const cell = new UIProjectionCell('tool-heavy', 'main')
      for (const row of rows) cell.apply([row])
      cell.sealReplay()
    })
    expect(perRow).toBeLessThan(50)
  })
})
