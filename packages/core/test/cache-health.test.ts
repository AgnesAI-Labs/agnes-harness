import { describe, expect, it } from 'vitest'
import {
  applyCacheHealthEvent,
  cacheHealthView,
  initialCacheHealthState,
} from '../src/project/cache-health.js'
import type { Event } from '../src/types.js'

const header = (seq: number, promptPrefixHash: string, lane = 'main'): Event =>
  ({
    seq,
    ts: '2026-09-14T00:00:00.000Z',
    id: `01K00000000000000000000${String(seq).padStart(2, '0')}`,
    type: 'request/header',
    data: {
      derived_hash: 'd',
      prompt_prefix_hash: promptPrefixHash,
      tool_schema_hash: 't',
      parser_version: '1',
      contract_id: null,
      model: 'deepseek-v4-pro',
      envelopeNonce: 'n',
    },
    actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
    lane,
    v: 1,
  }) as Event

const inferenceRow = (
  seq: number,
  effectId: string,
  tokens: { input: number; cacheRead: number; cacheWrite: number },
  lane = 'main',
): Event =>
  ({
    seq,
    ts: '2026-09-14T00:00:00.000Z',
    id: `01K00000000000000000000${String(seq).padStart(2, '0')}`,
    type: 'cost/ledger',
    data: {
      purpose: 'inference',
      effectId,
      tokens: { ...tokens, output: 1 },
      creditSource: 'gateway',
      model: 'deepseek-v4-pro',
    },
    actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
    lane,
    v: 1,
  }) as Event

describe('cacheHealthView', () => {
  it('has no hit rate when no inference row has been seen', () => {
    expect(cacheHealthView(initialCacheHealthState())).toEqual({})
  })

  it('divides by input + cacheRead + cacheWrite, not by input alone', () => {
    let state = initialCacheHealthState()
    state = applyCacheHealthEvent(state, header(1, 'h1'), 'main')
    // promptTokens = input(2) + cacheRead(3) + cacheWrite(4) = 9, dividing by input alone (2) would
    // give a rate above 1, which is meaningless for a hit *rate*.
    state = applyCacheHealthEvent(
      state,
      inferenceRow(2, 'e1', { input: 2, cacheRead: 3, cacheWrite: 4 }),
      'main',
    )
    expect(cacheHealthView(state).hitRate).toBeCloseTo(3 / 9)
  })

  it('does not flag the first inference row of a lane as an invalidation', () => {
    let state = initialCacheHealthState()
    state = applyCacheHealthEvent(state, header(1, 'h1'), 'main')
    state = applyCacheHealthEvent(
      state,
      inferenceRow(2, 'e1', { input: 5000, cacheRead: 0, cacheWrite: 0 }),
      'main',
    )
    expect(cacheHealthView(state).lastInvalidation).toBeUndefined()
  })
})

describe('cache invalidation detection', () => {
  it('flags a compaction-caused cold turn, using the surfaceOp replace marker', () => {
    let state = initialCacheHealthState()
    state = applyCacheHealthEvent(state, header(1, 'h1'), 'main')
    state = applyCacheHealthEvent(
      state,
      inferenceRow(2, 'e1', { input: 500, cacheRead: 9000, cacheWrite: 0 }),
      'main',
    )
    const compactionReplace: Event = {
      seq: 3,
      ts: '2026-09-14T00:00:00.000Z',
      id: '01K000000000000000000003',
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' },
      actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
      origin: 'model',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      surfaceOp: { op: 'replace', start: 1, end: 2 },
    } as Event
    state = applyCacheHealthEvent(state, compactionReplace, 'main')
    // Same prefix hash as before -- compaction does not touch system/tools, only messages.
    state = applyCacheHealthEvent(state, header(4, 'h1'), 'main')
    state = applyCacheHealthEvent(
      state,
      inferenceRow(5, 'e2', { input: 9500, cacheRead: 0, cacheWrite: 0 }),
      'main',
    )
    expect(cacheHealthView(state).lastInvalidation).toEqual({
      seq: 5,
      reprocessedTokens: 9500,
      cause: 'compaction',
    })
  })

  it('flags a system-prefix change via the prompt_prefix_hash, independent of cacheWrite', () => {
    let state = initialCacheHealthState()
    state = applyCacheHealthEvent(state, header(1, 'h1'), 'main')
    state = applyCacheHealthEvent(
      state,
      inferenceRow(2, 'e1', { input: 500, cacheRead: 9000, cacheWrite: 0 }),
      'main',
    )
    // Prefix hash changes (e.g. a preset/model switch touched a section) -- no compaction event.
    state = applyCacheHealthEvent(state, header(3, 'h2'), 'main')
    // cacheWrite stays 0, matching our two implicit-cache primaries: the reference's cacheWrite > 0
    // gate would never fire here, which is exactly the adaptation this module makes.
    state = applyCacheHealthEvent(
      state,
      inferenceRow(4, 'e2', { input: 9500, cacheRead: 0, cacheWrite: 0 }),
      'main',
    )
    expect(cacheHealthView(state).lastInvalidation).toEqual({
      seq: 4,
      reprocessedTokens: 9500,
      cause: 'system-changed',
    })
  })

  it('falls back to history-changed when neither compaction nor a prefix-hash change explains it', () => {
    let state = initialCacheHealthState()
    state = applyCacheHealthEvent(state, header(1, 'h1'), 'main')
    state = applyCacheHealthEvent(
      state,
      inferenceRow(2, 'e1', { input: 500, cacheRead: 9000, cacheWrite: 0 }),
      'main',
    )
    state = applyCacheHealthEvent(state, header(3, 'h1'), 'main')
    state = applyCacheHealthEvent(
      state,
      inferenceRow(4, 'e2', { input: 9500, cacheRead: 0, cacheWrite: 0 }),
      'main',
    )
    expect(cacheHealthView(state).lastInvalidation).toMatchObject({ cause: 'history-changed' })
  })

  it('does not flag a turn whose predecessor never warmed the cache above the footprint floor', () => {
    let state = initialCacheHealthState()
    state = applyCacheHealthEvent(state, header(1, 'h1'), 'main')
    state = applyCacheHealthEvent(
      state,
      inferenceRow(2, 'e1', { input: 500, cacheRead: 100, cacheWrite: 0 }),
      'main',
    )
    state = applyCacheHealthEvent(state, header(3, 'h1'), 'main')
    // input alone clears MIN_CACHE_FOOTPRINT (2048) on this row, so reprocessedTokens would pass its
    // own floor check regardless of what the predecessor's cacheRead was. That isolates the
    // assertion to the predecessor-warmth gate specifically -- with input: 500 (as this case
    // originally read), reprocessedTokens itself stayed under the floor too, so the case passed
    // without that gate ever being reached; a mutation removing it went undetected until reverse
    // verification actually confirmed it.
    state = applyCacheHealthEvent(
      state,
      inferenceRow(4, 'e2', { input: 3000, cacheRead: 0, cacheWrite: 0 }),
      'main',
    )
    expect(cacheHealthView(state).lastInvalidation).toBeUndefined()
  })
})

describe('a DeepSeek-shaped session: warm cache, one compaction, one dip, one recovery', () => {
  it('reports a hit rate above zero and exactly one invalidation', () => {
    let state = initialCacheHealthState()
    // Turns 1-5: warm, implicit-cache DeepSeek session -- cacheWrite stays 0 throughout, cacheRead
    // grows as the prefix grows, matching the real provider's reported shape (spec §2.6).
    const turns = [
      { input: 2000, cacheRead: 0, cacheWrite: 0 },
      { input: 800, cacheRead: 2000, cacheWrite: 0 },
      { input: 900, cacheRead: 2800, cacheWrite: 0 },
      { input: 1000, cacheRead: 3700, cacheWrite: 0 },
      { input: 1100, cacheRead: 4700, cacheWrite: 0 },
    ]
    let seq = 0
    for (const [i, tokens] of turns.entries()) {
      seq += 1
      state = applyCacheHealthEvent(state, header(seq, 'h1'), 'main')
      seq += 1
      state = applyCacheHealthEvent(state, inferenceRow(seq, `warm-${i}`, tokens), 'main')
    }
    expect(cacheHealthView(state).lastInvalidation).toBeUndefined()

    // Compaction runs: surfaceOp replace, same prefix hash (compaction never touches system/tools).
    seq += 1
    const compactionReplace: Event = {
      seq,
      ts: '2026-09-14T00:00:00.000Z',
      id: `01K0000000000000000000${String(seq).padStart(2, '0')}`,
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'summary' }], stopReason: 'end_turn' },
      actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
      origin: 'model',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      surfaceOp: { op: 'replace', start: 1, end: 8 },
    } as Event
    state = applyCacheHealthEvent(state, compactionReplace, 'main')

    // The turn right after compaction: history bytes changed (the summary replaced old messages),
    // so the prefix is cold -- cacheRead collapses to 0 while the prompt is still large.
    seq += 1
    state = applyCacheHealthEvent(state, header(seq, 'h1'), 'main')
    seq += 1
    state = applyCacheHealthEvent(
      state,
      inferenceRow(seq, 'post-compaction', { input: 6000, cacheRead: 0, cacheWrite: 0 }),
      'main',
    )
    const dip = cacheHealthView(state).lastInvalidation
    expect(dip).toMatchObject({ cause: 'compaction' })

    // Recovery: the prefix re-warms over the next two turns, no further invalidation.
    seq += 1
    state = applyCacheHealthEvent(state, header(seq, 'h1'), 'main')
    seq += 1
    state = applyCacheHealthEvent(
      state,
      inferenceRow(seq, 'recover-1', { input: 500, cacheRead: 6000, cacheWrite: 0 }),
      'main',
    )
    seq += 1
    state = applyCacheHealthEvent(state, header(seq, 'h1'), 'main')
    seq += 1
    state = applyCacheHealthEvent(
      state,
      inferenceRow(seq, 'recover-2', { input: 600, cacheRead: 6500, cacheWrite: 0 }),
      'main',
    )

    // Exactly one dip: lastInvalidation still points at the post-compaction turn, not a later one.
    expect(cacheHealthView(state).lastInvalidation).toEqual(dip)
    expect(cacheHealthView(state).hitRate).toBeGreaterThan(0)
  })
})
