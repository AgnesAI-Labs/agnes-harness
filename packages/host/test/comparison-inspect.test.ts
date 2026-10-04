import { canonicalJson, sha256Hex } from '@agnes/core'
import type { EventEnvelope, InboxItem, JsonValue } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { inspectComparisonInput } from '../src/runtime/comparison-inspect.js'

const actor = { id: 'test', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const queued: InboxItem = {
  itemId: 'item-one',
  commandId: 'input-one',
  admissionId: 'a'.repeat(64),
  target: 'next-turn',
  content: [{ type: 'text', text: 'Same text is not identity' }],
  actor,
  enqueuedAt: '2026-10-02T00:00:00.000Z',
  kind: 'prompt',
}
function rows(reason = 'completed'): EventEnvelope[] {
  const values: [string, JsonValue][] = [
    ['session/start', { key: 'session', resolvedProfileHash: null, preset: null, agnesVersion: '1' }],
    ['inbox', { items: [queued] } as unknown as JsonValue],
    ['inbox', { items: [] }],
    ['user/message', { content: queued.content, kind: 'prompt' } as JsonValue],
    ['turn/start', { turn: 1, trigger: 'prompt' }],
    ['turn/end', { reason, lastAssistantSeq: null }],
  ]
  return values.map(([type, data], index) => ({
    seq: index + 1,
    id: '01K5MMRH00000000000000000000',
    ts: '2026-10-02T00:00:00.000Z',
    type,
    data,
    actor,
    origin: type === 'user/message' ? 'principal' : 'system',
    trust: 'trusted',
    lane: 'main',
  }))
}
async function inspect(
  events: EventEnvelope[],
  changes: Partial<Parameters<typeof inspectComparisonInput>[0]> = {},
) {
  return inspectComparisonInput({
    sessionId: 'session',
    inputId: 'input-one',
    throughSeq: events.at(-1)?.seq ?? 0,
    async scan(query) {
      expect(query.toSeq).toBe(changes.throughSeq ?? events.at(-1)?.seq ?? 0)
      return events
        .filter((row) => row.seq >= (query.fromSeq ?? 1) && row.seq <= (query.toSeq ?? 0))
        .slice(0, query.limit)
    },
    ...changes,
  })
}

describe('read-only comparison ledger inspection', () => {
  it('recovers the exact durable admission and its own turn settlement', async () => {
    expect(await inspect(rows())).toEqual({
      receipt: { status: 'accepted', seq: 2 },
      state: { phase: 'idle', lastSeq: 6, settled: true, terminalCause: 'finished' },
    })
    expect(await inspect(rows(), { throughSeq: 5 })).toEqual({
      receipt: { status: 'accepted', seq: 2 },
      state: { phase: 'recovering', lastSeq: 5, settled: false },
    })
    for (const [reason, terminalCause] of [
      ['aborted', 'cancelled'],
      ['error', 'failed'],
      ['budget', 'failed'],
    ] as const)
      expect(await inspect(rows(reason))).toMatchObject({ state: { settled: true, terminalCause } })
  })
  it.each(['blocked', 'parked', 'interrupted'])(
    'keeps %s pending instead of completing the round',
    async (reason) => {
      expect(await inspect(rows(reason))).toMatchObject({
        receipt: { status: 'accepted' },
        state: { settled: false },
      })
    },
  )
  it('reconciles a lost cancellation acknowledgement only from a trusted fence and exact released admission', async () => {
    const admission = {
      version: 1,
      id: 'c'.repeat(64),
      commandId: queued.commandId!,
      payloadDigest: sha256Hex(canonicalJson(queued.content)),
      configurationDigest: 'd'.repeat(64),
      writerRunId: 'owner',
      sessionId: 'session',
      lane: 'main',
      runtime: { id: 'native', version: '1' },
      status: 'held',
    }
    const template = rows()[0]!
    const evidence: EventEnvelope[] = [
      template,
      {
        ...template,
        type: 'x/core/configuration-admission',
        ignorable: true as const,
        register: 'execution.admission',
        data: admission,
      },
      { ...template, type: 'inbox', data: { items: [queued] } as unknown as JsonValue },
      {
        ...template,
        type: 'x/core/input-cancelled',
        ignorable: true as const,
        data: { version: 1, sessionId: 'session', commandId: queued.commandId! },
      },
      { ...template, type: 'inbox', data: { items: [] } },
      {
        ...template,
        type: 'x/core/configuration-admission',
        ignorable: true as const,
        register: 'execution.admission',
        data: { ...admission, status: 'released' },
      },
    ].map((event, index) => ({ ...event, seq: index + 1 }))
    expect(await inspect(evidence)).toEqual({
      receipt: { status: 'accepted', seq: 3 },
      cancellation: 'acknowledged',
      state: { phase: 'idle', lastSeq: 6, settled: true, terminalCause: 'cancelled' },
    })
    expect(await inspect(evidence.slice(0, 5))).toEqual({ receipt: { status: 'accepted', seq: 3 } })
    const wrongOwner = structuredClone(evidence)
    wrongOwner[5]!.data = { ...admission, status: 'released', writerRunId: 'replacement' }
    expect((await inspect(wrongOwner)).cancellation).toBeUndefined()
    const untrusted = structuredClone(evidence)
    untrusted[3]!.trust = 'untrusted'
    expect((await inspect(untrusted)).cancellation).toBeUndefined()
    const partial = evidence
      .filter((event) => event.seq !== 4)
      .map((event, index) => ({ ...event, seq: index + 1 }))
    expect((await inspect(partial)).state).toBeUndefined()
    const neverQueued = [template, { ...evidence[3]!, seq: 2 }]
    expect(await inspect(neverQueued)).toEqual({
      receipt: { status: 'unknown' },
      cancellation: 'acknowledged',
    })
  })

  it('does not confuse another input with equal text or a later unrelated turn ending', async () => {
    const events = rows()
    const other = { ...queued, itemId: 'other-item', commandId: 'other-input', admissionId: 'b'.repeat(64) }
    events[1]!.data = { items: [queued, other] } as unknown as JsonValue
    events[2]!.data = { items: [other] } as unknown as JsonValue
    // This removal is cancellation, then a new inbox claim owns the identical user text.
    events.splice(3, 0, { ...events[2]!, data: { items: [] } })
    events.forEach((row, index) => {
      row.seq = index + 1
    })
    expect(await inspect(events)).toEqual({ receipt: { status: 'accepted', seq: 2 } })
    const overlapping = rows()
    overlapping.splice(5, 0, { ...overlapping[4]!, data: { turn: 2, trigger: 'prompt' } })
    overlapping.forEach((row, index) => {
      row.seq = index + 1
    })
    expect(await inspect(overlapping)).toEqual({ receipt: { status: 'accepted', seq: 2 } })
  })
  it('follows only an explicit continuation of the input-owned turn', async () => {
    const events = rows('blocked')
    events.push(
      {
        ...events[4]!,
        seq: 7,
        data: { turn: 2, trigger: 'approval-resume', continues: { turn: 1, step: 1 } },
      },
      { ...events[5]!, seq: 8, data: { reason: 'completed', lastAssistantSeq: null } },
    )
    expect(await inspect(events)).toMatchObject({ state: { phase: 'idle', lastSeq: 8, settled: true } })
  })
  it('keeps absent, foreign, duplicate, truncated and failed scans unknown', async () => {
    expect(await inspect(rows(), { inputId: 'absent' })).toEqual({ receipt: { status: 'unknown' } })
    expect(await inspect(rows(), { sessionId: 'foreign' })).toEqual({ receipt: { status: 'unknown' } })
    expect(await inspect(rows().filter((row) => row.seq !== 3))).toEqual({ receipt: { status: 'unknown' } })
    expect(await inspect(rows(), { maxEvents: 3 })).toEqual({ receipt: { status: 'unknown' } })
    expect(await inspect(rows(), { maxBytes: 32 })).toEqual({ receipt: { status: 'unknown' } })
    expect(
      await inspect(rows(), {
        scan: async () => {
          throw new Error('storage unavailable')
        },
      }),
    ).toEqual({ receipt: { status: 'unknown' } })
    const duplicate = rows()
    duplicate[1]!.data = { items: [queued, { ...queued, itemId: 'duplicate' }] } as unknown as JsonValue
    expect(await inspect(duplicate)).toEqual({ receipt: { status: 'unknown' } })
  })
  it('keeps the frozen upper cursor on every page and does not read a future terminal row', async () => {
    const events = rows().slice(0, 5)
    while (events.length < 257)
      events.push({ ...events[4]!, seq: events.length + 1, type: 'step/start', data: { turn: 1, step: 1 } })
    events.push({ ...rows()[5]!, seq: 258 })
    const throughSeq = 257
    expect(await inspect(events, { throughSeq })).toMatchObject({ state: { lastSeq: 257, settled: false } })
  })
})
