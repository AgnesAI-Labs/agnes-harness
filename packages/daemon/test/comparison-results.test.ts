import type { ComparisonJournalFact, EventEnvelope, JsonValue } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { comparisonLaneResult } from '../src/local/comparison-results.js'

type Coordinator = Extract<ComparisonJournalFact, { kind: 'coordinator' }>
const actor = { id: 'test', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const content = [{ type: 'text', text: 'same prompt' }]
const queued = {
  itemId: 'item',
  commandId: 'input',
  admissionId: 'a'.repeat(64),
  target: 'next-turn',
  content,
  actor,
  enqueuedAt: '2026-10-03T00:00:00.000Z',
  kind: 'prompt',
}
const events: EventEnvelope[] = (
  [
    ['session/start', { key: 'session', resolvedProfileHash: null, preset: null, agnesVersion: '1' }],
    ['inbox', { items: [queued] }],
    ['inbox', { items: [] }],
    ['user/message', { content, kind: 'prompt' }],
    ['turn/start', { turn: 1, trigger: 'prompt' }],
    ['assistant/message', { content: [{ type: 'text', text: 'verified answer' }], stopReason: 'end_turn' }],
    ['turn/end', { reason: 'completed', lastAssistantSeq: 6 }],
  ] as [string, JsonValue][]
).map(([type, data], index) => ({
  seq: index + 1,
  id: '01K5MMRH00000000000000000000',
  ts: '2026-10-03T00:00:00.000Z',
  type,
  data,
  actor,
  origin: type === 'user/message' ? 'principal' : 'system',
  trust: 'trusted',
  lane: 'main',
}))
const coordinator: Coordinator = {
  kind: 'coordinator',
  revision: 4,
  creation: 'ready',
  lanes: { left: { sessionId: 'session', runtime: { id: 'native', version: '1' }, phase: 'idle' } },
  roundCount: 1,
  latestRound: {
    inputId: 'input',
    runs: { left: 'settled', right: 'settled' },
    terminalCauses: { left: 'finished', right: 'finished' },
    acceptances: { left: 'accepted', right: 'accepted' },
    acceptedSeqs: { left: 2 },
    terminalSeqs: { left: 7 },
    timings: {
      left: {
        startedAt: '2026-10-03T00:00:00Z',
        finishedAt: '2026-10-03T00:00:01Z',
        elapsedMs: 1000,
        terminalConfirmed: true,
      },
    },
  },
  cancellation: {},
  cleanup: { exited: [], released: false },
}
function run(c = coordinator, throughSeq = 7, complete = true) {
  return comparisonLaneResult({
    side: 'left',
    sessionId: 'session',
    throughSeq,
    events: events.filter((event) => event.seq <= throughSeq),
    complete,
    coordinator: c,
    rounds: new Map(c.latestRound ? [[c.latestRound.inputId, c.latestRound]] : []),
  })
}
it('binds answer, terminal evidence and confirmed duration to the exact current input and cut', async () => {
  expect(await run()).toMatchObject({
    run: 'settled',
    terminalCause: 'finished',
    elapsedMs: 1000,
    latestAnswer: { seq: 6, text: 'verified answer', truncated: false },
    complete: true,
  })
  expect(await run(coordinator, 5)).toMatchObject({
    run: 'unknown',
    terminalCause: 'unknown',
    elapsedMs: null,
    latestAnswer: null,
    complete: false,
    issues: expect.arrayContaining(['settlement_not_captured']),
  })
  expect(await run(coordinator, 7, false)).toMatchObject({
    run: 'unknown',
    latestAnswer: null,
    complete: false,
  })
  // Another lane can append an answer inside this turn's sequence range.
  // Its text is not evidence for the comparison input.
  const interleaved = [
    ...events.slice(0, 6),
    { ...events[5]!, lane: 'other', data: { content: [{ type: 'text', text: 'unrelated answer' }] } },
    events[6]!,
  ].map((event, index) => ({ ...event, seq: index + 1 }))
  expect(
    await comparisonLaneResult({
      side: 'left',
      sessionId: 'session',
      throughSeq: 8,
      events: interleaved,
      complete: true,
      coordinator,
      rounds: new Map([[coordinator.latestRound!.inputId, coordinator.latestRound!]]),
    }),
  ).toMatchObject({ latestAnswer: { seq: 6, text: 'verified answer' } })
  const later = structuredClone(coordinator)
  if (!later.latestRound) throw new Error('fixture')
  later.latestRound.inputId = 'second-input'
  later.latestRound.acceptedSeqs.left = 8
  expect(await run(later)).toMatchObject({ run: 'unknown', latestAnswer: null, complete: false })
})
it('keeps missing duration unknown and never fills an earlier round from later journal facts', async () => {
  const legacy = structuredClone(coordinator)
  if (!legacy.latestRound) throw new Error('fixture')
  delete legacy.latestRound.timings
  expect(await run(legacy)).toMatchObject({ elapsedMs: null, latestAnswer: { text: 'verified answer' } })
  const multiple = { ...coordinator, roundCount: 2 }
  expect(await run(multiple)).toMatchObject({ elapsedMs: null })
  const original = JSON.stringify(events)
  const result = await run()
  events.push({ ...events[5]!, seq: 8, data: { content: [{ type: 'text', text: 'future answer' }] } })
  expect(await run()).toEqual(result)
  events.pop()
  expect(JSON.stringify(events)).toBe(original)
})
