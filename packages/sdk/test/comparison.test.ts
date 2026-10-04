import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type {
  ComparisonAccountingFamily,
  ComparisonAccountingTotal,
  ComparisonJournalEntry,
  ComparisonJournalParams,
  ComparisonJournalResult,
  ComparisonMetricsParams,
  ComparisonMetricsResult,
  ComparisonPriceDetail,
  ComparisonPriceDetailsParams,
  ComparisonReadToolDetailParams,
  ComparisonRound,
  ComparisonSnapshot,
  EventEnvelope,
} from '@agnes/protocol'
import { expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { ProtocolViolation } from '../src/errors.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

function captured<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing real quote fixture evidence')
  return value
}

// The wire fixture retains only actual quote/usage metadata from the sanitized Flash capture.
function realPriceDetail(): ComparisonPriceDetail {
  const capture = JSON.parse(
    readFileSync('packages/core/test/fixtures/comparison-real-pricing.json', 'utf8'),
  ) as {
    reports: { events: EventEnvelope[] }[]
  }
  const events = captured(capture.reports[0]).events
  const start = events.find(
    (event) => event.type === 'x/core/model-call' && (event.data as { stage?: string }).stage === 'started',
  )
  const record = captured(start).data as unknown as {
    id: string
    purpose: string
    route: string
    model: string
    pricing: NonNullable<ComparisonPriceDetail['quote']>
  }
  const settled = events.find(
    (event) =>
      event.type === 'x/core/model-call' &&
      (event.data as { stage?: string; id?: string }).stage === 'settled' &&
      (event.data as { id?: string }).id === record.id,
  )
  const data = captured(settled).data as unknown as {
    usage: {
      tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
      billing: NonNullable<ComparisonPriceDetail['reportedBilling']>
    }
  }
  const known = (value: number): ComparisonAccountingTotal => ({
    state: 'complete',
    value,
    knownSubtotal: value,
    missing: 0,
  })
  const usage = data.usage.tokens
  const tokens = {
    inputUncached: known(usage.input),
    cacheRead: known(usage.cacheRead),
    cacheWrite: known(usage.cacheWrite),
    output: known(usage.output),
    reasoning: known(usage.reasoning),
  }
  const bucketCosts = Object.fromEntries(
    Object.entries(tokens)
      .filter(([key]) => key !== 'reasoning')
      .map(([key, units]) => [
        key,
        known(
          (captured(units.value) *
            captured(
              record.pricing.policy.perMillion[key as keyof typeof record.pricing.policy.perMillion],
            )) /
            1_000_000,
        ),
      ]),
  ) as ComparisonPriceDetail['bucketCosts']
  return {
    attemptId: record.id,
    family: 'llm',
    purpose: record.purpose,
    route: record.route,
    model: record.model,
    observedModel: null,
    originSeq: captured(start).seq,
    settledSeq: captured(settled).seq,
    outcome: 'completed',
    quote: record.pricing,
    multiplier: 1,
    tokens,
    bucketCosts,
    estimate: known(Object.values(bucketCosts).reduce((sum, bucket) => sum + captured(bucket.value), 0)),
    reportedBilling: data.usage.billing,
    issues: [],
  }
}

it.each(['valid', 'private-content', 'missing-quote'] as const)(
  'reads safe fixed-cut price details (%s)',
  async (mode) => {
    const entry = realPriceDetail()
    const request: ComparisonPriceDetailsParams = {
      id: 'saved',
      side: 'left',
      atSeq: 99,
      afterSeq: 0,
      limit: 1,
    }
    const result = {
      ...request,
      sessionId: 'archived',
      runtime: { id: 'native', version: '1' },
      throughSeq: captured(entry.settledSeq),
      entries: [
        {
          ...entry,
          ...(mode === 'private-content'
            ? { prompt: 'private' }
            : mode === 'missing-quote'
              ? { quote: null }
              : {}),
        },
      ],
      nextAfterSeq: captured(entry.settledSeq),
      complete: true,
      evidenceComplete: true,
      issues: [],
    }
    const { limit: _limit, ...wire } = result
    const f = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/comparison.priceDetails': (params) => {
        expect(params).toEqual(request)
        return wire
      },
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: { local: () => localAuth() },
    })
    try {
      if (mode === 'private-content')
        await expect(client.comparison.priceDetails(request)).rejects.toBeInstanceOf(ProtocolViolation)
      else expect(await client.comparison.priceDetails(request)).toEqual(wire)
    } finally {
      await client.close()
    }
  },
)

it.each([
  'valid',
  'id',
  'side',
  'atSeq',
  'sessionId',
  'throughSeq',
  'first-session',
  'first-cut',
  'abort',
] as const)('assembles comparison tool details with fixed source identity (%s)', async (mode) => {
  const capture = JSON.parse(readFileSync('packages/core/test/fixtures/jev-real-trace.json', 'utf8')) as {
    events: EventEnvelope[]
  }
  const detail = { call: capture.events[27]!.data, result: capture.events[31]!.data }
  const bytes = Buffer.from(JSON.stringify(detail))
  const input = { id: 'pair', side: 'right' as const, atSeq: 99, callSeq: 28, resultSeq: 32 }
  const controller = new AbortController()
  const f = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    '_agnes/v1/comparison.readToolDetail': (params) => {
      const offset = (params as ComparisonReadToolDetailParams).offset ?? 0
      const end = Math.min(offset + 64, bytes.length)
      const identity = {
        id: input.id,
        side: input.side,
        atSeq: input.atSeq,
        sessionId: mode === 'first-session' ? 'wrong-initial-session' : 'archived-jev',
        throughSeq: mode === 'first-cut' ? 33 : 32,
      }
      if (mode === 'abort') controller.abort()
      const changed =
        offset > 0 && mode !== 'valid' && mode !== 'abort' && !mode.startsWith('first-')
          ? {
              [mode]:
                mode === 'side' ? 'left' : mode === 'atSeq' ? 100 : mode === 'throughSeq' ? 33 : 'different',
            }
          : {}
      return {
        ...identity,
        ...changed,
        ok: true,
        page: {
          callSeq: 28,
          resultSeq: 32,
          offset,
          totalBytes: bytes.length,
          data: bytes.subarray(offset, end).toString('base64'),
          nextOffset: end === bytes.length ? null : end,
        },
      }
    },
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
  })
  try {
    const result = client.comparison.toolDetail(input, {
      signal: controller.signal,
      ...(mode.startsWith('first-') ? { expectedSource: { sessionId: 'archived-jev', throughSeq: 32 } } : {}),
    })
    if (mode === 'valid') await expect(result).resolves.toEqual(detail)
    else if (mode === 'abort') await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    else await expect(result).rejects.toBeInstanceOf(ProtocolViolation)
    expect(
      f.calls
        .filter((call) => call.method !== 'initialize')
        .every((call) => call.method === '_agnes/v1/comparison.readToolDetail'),
    ).toBe(true)
    if (mode === 'abort' || mode.startsWith('first-'))
      expect(f.calls.filter((call) => call.method === '_agnes/v1/comparison.readToolDetail')).toHaveLength(1)
    expect(client.sessions.size).toBe(0)
  } finally {
    await client.close()
  }
})

it('exposes stored events and generation-free projections without opening sessions', async () => {
  const fixture = JSON.parse(
    readFileSync('packages/core/test/fixtures/comparison-real-cancel.json', 'utf8'),
  ) as {
    reports: {
      lane: { sessionId: string }
      events: EventEnvelope[]
      replayProjections: { upto: number; timeline: unknown }[]
    }[]
  }
  const report = fixture.reports[0]!
  const projection = report.replayProjections.find((value) => value.upto === 6)!
  const coordinates = {
    id: 'pair',
    side: 'left' as const,
    atSeq: 10,
    sessionId: report.lane.sessionId,
    throughSeq: 6,
  }
  const events = {
    ...coordinates,
    afterSeq: 0,
    events: report.events.slice(0, 6),
    nextAfterSeq: 6,
    complete: true,
  }
  const projected = { ...coordinates, timeline: projection.timeline }
  let projectionReply = projected
  const f = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    '_agnes/v1/comparison.events': () => events,
    '_agnes/v1/comparison.projectUI': () => projectionReply,
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
  })
  const input = { id: 'pair', side: 'left' as const, atSeq: 10 }
  try {
    expect(await client.comparison.events({ ...input, afterSeq: 0 })).toEqual(events)
    expect(await client.comparison.projectUI({ ...input, surface: 'web' })).toEqual(projected)
    projectionReply = { ...projected, timeline: { ...(projection.timeline as object), generation: 1 } }
    await expect(client.comparison.projectUI({ ...input, surface: 'web' })).rejects.toBeInstanceOf(
      ProtocolViolation,
    )
    await expect(
      client.comparison.events({ ...input, afterSeq: 0, sessionId: 'injected' } as Parameters<
        typeof client.comparison.events
      >[0]),
    ).rejects.toBeInstanceOf(ProtocolViolation)
    expect(client.sessions.size).toBe(0)
  } finally {
    await client.close()
  }
})

it('coordinates paired input through the backend and retains unknown acceptance without resending', async () => {
  const round: ComparisonRound = {
    inputId: 'input-1',
    acceptances: [
      { side: 'left', sessionId: 'l', status: 'accepted', seq: 4 },
      {
        side: 'right',
        sessionId: 'r',
        status: 'unknown',
        error: { code: 'OUTCOME_UNKNOWN', message: 'Worker disconnected' },
      },
    ],
    settledSides: [],
    terminalCauses: [],
  }
  const snapshot: ComparisonSnapshot = {
    id: 'pair',
    revision: 1,
    phase: 'partial',
    baselineId: 'baseline',
    baselineDigest: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
    lanes: [
      {
        side: 'left',
        sessionId: 'l',
        runtime: { id: 'native', version: '1' },
        workspaceLabel: 'Native workspace',
        phase: 'running',
        lastSeq: 4,
      },
      {
        side: 'right',
        sessionId: 'r',
        runtime: { id: 'jevloop', version: '1' },
        workspaceLabel: 'JevLoop workspace',
        phase: 'recovering',
        lastSeq: 0,
      },
    ],
    rounds: [round],
    metrics: { state: 'unknown' },
  }
  const f = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    '_agnes/v1/comparison.list': () => ({ items: [], nextCursor: null }),
    '_agnes/v1/comparison.create': () => snapshot,
    '_agnes/v1/comparison.get': () => snapshot,
    '_agnes/v1/comparison.reconcile': () => snapshot,
    '_agnes/v1/comparison.submit': () => round,
    '_agnes/v1/comparison.cancel': () => snapshot,
    '_agnes/v1/comparison.release': (input) =>
      (input as { id: string }).id === 'failed'
        ? { id: 'failed', revision: 5, storageState: 'released', kind: 'failed-preparation' }
        : { ...snapshot, storageState: 'released' },
    '_agnes/v1/comparison.remove': () => ({ id: 'pair', revision: 5, storageState: 'removed' }),
    '_agnes/v1/comparison.prune': () => ({
      items: [{ id: 'pair', ok: true, revision: 5, storageState: 'removed' }],
    }),
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: { local: () => localAuth() },
  })
  const create = {
    requestId: 'create-1',
    cwd: '/w',
    left: { runtime: 'native' },
    right: { runtime: 'jevloop' },
  }
  const input = { id: 'pair', inputId: 'input-1', content: [{ type: 'text' as const, text: 'Do the task' }] }
  try {
    expect(await client.comparison.list({ limit: 25 })).toEqual({ items: [], nextCursor: null })
    expect(await client.comparison.create(create)).toEqual(snapshot)
    expect(await client.comparison.submit(input)).toEqual(round)
    expect(await client.comparison.get('pair')).toEqual(snapshot)
    expect(await client.comparison.reconcile('pair')).toEqual(snapshot)
    await client.comparison.cancel({ id: 'pair', side: 'left' })
    expect((await client.comparison.release({ id: 'pair', expectedRevision: 3 })).storageState).toBe(
      'released',
    )
    expect(await client.comparison.release({ id: 'failed', expectedRevision: 4 })).toEqual({
      id: 'failed',
      revision: 5,
      storageState: 'released',
      kind: 'failed-preparation',
    })
    expect((await client.comparison.remove({ id: 'pair', expectedRevision: 4 })).storageState).toBe('removed')
    expect(
      (await client.comparison.prune({ operation: 'remove', items: [{ id: 'pair', expectedRevision: 4 }] }))
        .items[0]?.ok,
    ).toBe(true)
    expect(f.calls.filter((call) => call.method !== 'initialize')).toEqual([
      { method: '_agnes/v1/comparison.list', params: { limit: 25 } },
      { method: '_agnes/v1/comparison.create', params: create },
      { method: '_agnes/v1/comparison.submit', params: input },
      { method: '_agnes/v1/comparison.get', params: { id: 'pair' } },
      { method: '_agnes/v1/comparison.reconcile', params: { id: 'pair' } },
      { method: '_agnes/v1/comparison.cancel', params: { id: 'pair', side: 'left' } },
      { method: '_agnes/v1/comparison.release', params: { id: 'pair', expectedRevision: 3 } },
      { method: '_agnes/v1/comparison.release', params: { id: 'failed', expectedRevision: 4 } },
      { method: '_agnes/v1/comparison.remove', params: { id: 'pair', expectedRevision: 4 } },
      {
        method: '_agnes/v1/comparison.prune',
        params: { operation: 'remove', items: [{ id: 'pair', expectedRevision: 4 }] },
      },
    ])
  } finally {
    await client.close()
  }
})

it('reads a fixed journal prefix and conservative accounting from sanitized real lane captures', async () => {
  // Source events are real; cross-lane publication order is a synthetic API response fixture.
  const capture = JSON.parse(
    readFileSync(new URL('../../core/test/fixtures/comparison-real-cancel.json', import.meta.url), 'utf8'),
  ) as { pair: ComparisonSnapshot; reports: { events: EventEnvelope[] }[] }
  const entries: ComparisonJournalEntry[] = [
    {
      seq: 1,
      cuts: { left: 0, right: 0 },
      fact: { kind: 'checkpoint', reason: 'baseline', coverage: 'unknown-interleaving' },
    },
  ]
  const cuts = { left: 0, right: 0 }
  for (const [index, report] of capture.reports.entries()) {
    const lane = capture.pair.lanes[index]
    if (lane === undefined) throw new Error('Missing captured lane')
    for (const event of report.events) {
      cuts[lane.side] = event.seq
      entries.push({
        seq: entries.length + 1,
        cuts: { ...cuts },
        fact: {
          kind: 'lane',
          side: lane.side,
          sessionId: lane.sessionId,
          localSeq: event.seq,
          digest: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
        },
      })
    }
  }
  const round = capture.pair.rounds[0]
  if (round === undefined) throw new Error('Missing captured round')
  entries.push({
    seq: entries.length + 1,
    cuts: { ...cuts },
    fact: {
      kind: 'coordinator',
      revision: capture.pair.revision,
      creation: 'ready',
      lanes: Object.fromEntries(
        capture.pair.lanes.map(({ side, sessionId, runtime, phase }) => [
          side,
          { sessionId, runtime, phase },
        ]),
      ),
      roundCount: capture.pair.rounds.length,
      latestRound: {
        inputId: round.inputId,
        runs: { left: 'settled', right: 'settled' },
        terminalCauses: { left: 'cancelled', right: 'finished' },
        acceptances: { left: 'accepted', right: 'accepted' },
        acceptedSeqs: { left: 4, right: 4 },
      },
      cancellation: { left: 'acknowledged' },
      cleanup: { exited: [], released: false },
    },
  })
  const throughSeq = entries.length
  const journal: ComparisonJournalResult = {
    id: capture.pair.id,
    entries,
    afterSeq: 0,
    throughSeq,
    nextAfterSeq: throughSeq,
    complete: true,
  }
  const known = (value: number): ComparisonAccountingTotal => ({
    state: 'complete',
    value,
    knownSubtotal: value,
    missing: 0,
  })
  const unknown: ComparisonAccountingTotal = {
    state: 'unknown',
    value: null,
    knownSubtotal: null,
    missing: 1,
  }
  const family = (
    attempts: number,
    tokens: ComparisonAccountingFamily['tokens'],
    unpricedAttempts: number,
  ): ComparisonAccountingFamily => ({ attempts, tokens, costs: {}, unpricedAttempts })
  const empty = family(
    0,
    {
      inputUncached: known(0),
      cacheRead: known(0),
      cacheWrite: known(0),
      output: known(0),
      reasoning: known(0),
    },
    0,
  )
  const missing = {
    inputUncached: unknown,
    cacheRead: unknown,
    cacheWrite: unknown,
    output: unknown,
    reasoning: unknown,
  }
  const metrics: ComparisonMetricsResult = {
    id: capture.pair.id,
    atSeq: throughSeq,
    cuts,
    lanes: capture.pair.lanes.map(({ side, sessionId, runtime }) => ({
      side,
      sessionId,
      runtime,
      accounting: {
        afterSeq: 0,
        throughSeq: cuts[side],
        state: side === 'left' ? 'unknown' : 'partial',
        issues: [],
        jev: side === 'left' ? empty : family(1, { ...missing, output: known(848) }, 1),
        llm:
          side === 'left'
            ? family(1, missing, 1)
            : family(
                1,
                {
                  inputUncached: known(1389),
                  cacheRead: known(8192),
                  cacheWrite: known(0),
                  output: known(1206),
                  reasoning: known(77),
                },
                1,
              ),
      },
    })),
  }
  let metricsReply: unknown = metrics
  const f = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    '_agnes/v1/comparison.journal': (params) => {
      const { afterSeq = 0 } = params as ComparisonJournalParams
      return { ...journal, afterSeq, entries: entries.filter((entry) => entry.seq > afterSeq) }
    },
    '_agnes/v1/comparison.metrics': () => metricsReply,
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: { local: () => localAuth() },
  })
  const params = { id: capture.pair.id, afterSeq: 0, throughSeq, limit: 1000, maxBytes: 4194304 }
  try {
    expect(await client.comparison.journal(params)).toEqual(journal)
    expect(await client.comparison.journal({ ...params, afterSeq: throughSeq })).toEqual({
      ...journal,
      entries: [],
      afterSeq: throughSeq,
    })
    const result = await client.comparison.metrics({ id: capture.pair.id, atSeq: throughSeq })
    expect(result).toEqual(metrics)
    expect(result.lanes[0]?.accounting.llm.tokens.output.value).toBeNull()
    expect(result.lanes[1]?.accounting.llm.tokens.output.value).toBe(1206)
    expect(result.lanes[1]?.accounting.llm.costs).toEqual({})
    expect(entries.at(-1)?.fact).toMatchObject({
      latestRound: {
        terminalCauses: { left: 'cancelled', right: 'finished' },
        acceptedSeqs: { left: 4, right: 4 },
      },
    })
    const sent = f.calls.length
    for (const invalid of [
      { ...params, limit: 0 },
      { ...params, limit: 1001 },
      { ...params, maxBytes: 1 },
      { ...params, maxBytes: 4194305 },
      { ...params, afterSeq: -1 },
    ])
      await expect(client.comparison.journal(invalid)).rejects.toBeInstanceOf(ProtocolViolation)
    await expect(
      client.comparison.metrics({
        id: capture.pair.id,
        atSeq: throughSeq,
        afterSeq: 0,
      } as ComparisonMetricsParams),
    ).rejects.toBeInstanceOf(ProtocolViolation)
    expect(f.calls).toHaveLength(sent)
    const firstLane = metrics.lanes[0]
    if (firstLane === undefined) throw new Error('Missing accounting lane')
    metricsReply = {
      ...metrics,
      lanes: [
        {
          ...firstLane,
          accounting: {
            ...firstLane.accounting,
            llm: { ...firstLane.accounting.llm, costs: { USD: 0 } },
          },
        },
      ],
    }
    await expect(
      client.comparison.metrics({ id: capture.pair.id, atSeq: throughSeq }),
    ).rejects.toBeInstanceOf(ProtocolViolation)
    expect(f.calls.filter((call) => call.method !== 'initialize').map((call) => call.method)).toEqual([
      '_agnes/v1/comparison.journal',
      '_agnes/v1/comparison.journal',
      '_agnes/v1/comparison.metrics',
      '_agnes/v1/comparison.metrics',
    ])
  } finally {
    await client.close()
  }
})
