/** @vitest-environment happy-dom */
import type { EventEnvelope } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { createJevDecisionGraph, type JevReplayCut } from '../src/jev-decision-graph.js'
import { createJevTranslate } from '../src/jev-locale.js'
import { createRuntimeRecordTrace } from '../src/runtime-record-trace.js'

const t = createJevTranslate('zh-CN')

afterEach(() => vi.useRealTimers())

function event(
  seq: number,
  record: Record<string, unknown>,
  turn = 'turn-a',
  step = 'step-a',
): EventEnvelope {
  return {
    seq,
    ts: new Date(seq * 1000).toISOString(),
    id: `host-${seq}`,
    type: 'runtime/record',
    data: {
      runtime: { id: 'jevloop', version: '1' },
      record: { version: 1, id: `record-${seq}`, turn, step, ...record },
    },
  } as unknown as EventEnvelope
}
const choice = (selected: string, keys: string[]) => ({
  type: 'choice',
  choice: selected,
  confidence: 0.9,
  probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0])),
})
const request = (purpose: string, input: unknown = {}) => ({
  purpose,
  backend: 'synthetic',
  endpoint: 'local',
  requestedModel: 'test-model',
  codec: 'systemone-json-v1',
  input,
  inputCursor: '0',
})
/** One complete Jev turn: manifest → decision → route → action → settlement → stop. */
function turnEvents(turn: string, base: number, stopDetail = 'done'): EventEnvelope[] {
  const manifest = {
    kind: 'jev.decision.manifest.v1',
    designRevision: 5,
    operations: [
      {
        purpose: 'INSPECT',
        question: 'operation_INSPECT',
        choices: [{ key: 'read', kind: 'tool', operation: 'read' }],
      },
      {
        purpose: 'VERIFY',
        question: 'operation_VERIFY',
        choices: [{ key: 'read', kind: 'tool', operation: 'read' }],
      },
      { purpose: 'RESPOND', question: null, choices: [{ key: 'RESPOND', kind: 'respond' }] },
    ],
    bindings: [
      {
        key: 'binding_read',
        operation: 'read',
        mode: 'parameterized',
        question: 'binding_read',
        choices: [{ key: 'known', candidate: { id: `${turn}-candidate` } }],
      },
    ],
  }
  return [
    event(base, { kind: 'resource.observed', resource: manifest }, turn),
    event(
      base + 1,
      {
        kind: 'model.requested',
        call: request('decision', {
          questions: {
            purpose: { type: 'choice', criteria: { INSPECT: 'Inspect', RESPOND: 'Respond' } },
            operation_INSPECT: { type: 'choice', criteria: { read: 'Read' } },
            operation_VERIFY: { type: 'choice', criteria: { read: 'Read' } },
            binding_read: { type: 'choice', criteria: { known: 'Known', LLM_PARAMETERS: 'Generate' } },
          },
        }),
      },
      turn,
    ),
    event(
      base + 2,
      {
        kind: 'model.settled',
        requested: `record-${base + 1}`,
        settlement: {
          output: {
            answers: {
              purpose: choice('INSPECT', ['INSPECT', 'RESPOND']),
              operation_INSPECT: choice('read', ['read']),
              operation_VERIFY: choice('read', ['read']),
              binding_read: choice('known', ['known', 'LLM_PARAMETERS']),
            },
          },
        },
      },
      turn,
    ),
    event(
      base + 3,
      {
        kind: 'decision.selected',
        requested: `record-${base + 1}`,
        phase: 'INSPECT',
        operation: 'read',
        candidateId: `${turn}-candidate`,
        confidence: 0.9,
      },
      turn,
    ),
    event(
      base + 4,
      {
        kind: 'resource.observed',
        resource: {
          kind: 'jev.decision.route.v1',
          requested: `record-${base + 1}`,
          decisionRecordId: `record-${base + 3}`,
          purpose: 'INSPECT',
          operation: 'read',
          reasons: [],
          supportApplied: true,
          supportingQuestionIds: ['operation_VERIFY'],
        },
      },
      turn,
    ),
    event(
      base + 5,
      {
        kind: 'action.intended',
        decision: `record-${base + 3}`,
        intent: {
          id: `${turn}-intent`,
          tool: 'read',
          arguments: { path: 'safe' },
          toolRevision: '1',
          environmentEpoch: `${turn}-env`,
          effectClass: 'read_only',
        },
      },
      turn,
    ),
    event(base + 6, { kind: 'action.dispatching', intentId: `${turn}-intent`, epoch: `${turn}-env` }, turn),
    event(
      base + 7,
      {
        kind: 'action.settled',
        intentId: `${turn}-intent`,
        outcome: { kind: 'success', content: [], directive: { conclude: false, additions: [] } },
        effect: 'applied',
        observations: [],
      },
      turn,
    ),
    event(base + 8, { kind: 'run.stopped', reason: 'blocked', detail: stopDetail, unresolved: [] }, turn),
  ]
}

function multiTurnFixture() {
  return [...turnEvents('turn-a', 1), ...turnEvents('turn-b', 10), ...turnEvents('turn-c', 19).slice(0, 3)]
}

const status = (host: HTMLElement) =>
  host.querySelector('.jev-graph-replay [role="status"]')?.textContent ?? ''

it('replays every persisted turn together by ledger seq and drives one shared conversation cut', () => {
  const events = multiTurnFixture()
  const cuts: Array<JevReplayCut | undefined> = []
  const host = document.createElement('section')
  const graph = createJevDecisionGraph(host, { onCut: (cut) => cuts.push(cut) }, t)
  vi.useFakeTimers()
  try {
    graph.update(events, 'session-a')
    const scope = host.querySelector<HTMLSelectElement>('[aria-label="Jev 回放范围"]')!
    const cursor = host.querySelector<HTMLInputElement>('[aria-label="Jev 账本回放位置"]')!
    // Default single-turn scope is unchanged: the cursor spans only the latest turn and no cut exists.
    expect(scope.value).toBe('turn')
    expect(cursor.max).toBe('2')
    cursor.value = '1'
    cursor.dispatchEvent(new Event('input'))
    expect(status(host)).toBe('回放 · #20')
    expect(cuts).toEqual([])
    // All-turn scope takes over the same position: the cursor now spans every persisted event
    // and the conversation cut starts from the seq single-turn replay was inspecting.
    scope.value = 'all'
    scope.dispatchEvent(new Event('change'))
    expect(status(host)).toBe('全轮回放 · #20')
    expect(cursor.max).toBe('20')
    expect(cuts).toEqual([{ sessionId: 'session-a', through: 20 }])
    // From-start replay advances continuously across turns by persisted seq.
    host.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
    expect(status(host)).toBe('全轮播放中 · #1')
    expect(cuts.at(-1)).toEqual({ sessionId: 'session-a', through: 1 })
    vi.advanceTimersByTime(500 * 9)
    expect(status(host)).toBe('全轮播放中 · #10')
    expect(host.querySelector('[data-stage="ledger"]')?.textContent).toContain('第 2 轮')
    const steps = host.querySelector<HTMLSelectElement>('[aria-label="Jev 轮次与步骤"]')!
    expect(steps.selectedOptions[0]?.textContent).toContain('第 2 轮')
    expect(cuts.at(-1)).toEqual({ sessionId: 'session-a', through: 10 })
    // Live growth beyond the cut never moves it.
    graph.update(
      [
        ...events,
        event(22, { kind: 'run.stopped', reason: 'blocked', detail: 'tail', unresolved: [] }, 'turn-c'),
      ],
      'session-a',
    )
    expect(cuts.at(-1)).toEqual({ sessionId: 'session-a', through: 10 })
    expect(cursor.max).toBe('21')
    // Finishing playback releases the conversation cut and returns the transcript to live.
    vi.advanceTimersByTime(500 * 12)
    expect(cuts.at(-1)).toBeUndefined()
    expect(status(host)).toBe('全轮实时 · #22')
    // Seeking again lands on the selected seq and emits exactly that cut.
    cursor.value = '5'
    cursor.dispatchEvent(new Event('input'))
    expect(status(host)).toBe('全轮回放 · #6')
    expect(cuts.at(-1)).toEqual({ sessionId: 'session-a', through: 6 })
    // Follow-latest restores the default single-turn live state and clears the cut.
    host.querySelector<HTMLButtonElement>('[aria-label="跟随最新"]')!.click()
    expect(cuts.at(-1)).toBeUndefined()
    expect(scope.value).toBe('turn')
    expect(status(host)).toBe('实时 · #22')
    // Returning to single-turn keeps the inspected position but stops owning the conversation cut.
    scope.value = 'all'
    scope.dispatchEvent(new Event('change'))
    host.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
    vi.advanceTimersByTime(500 * 11)
    expect(cuts.at(-1)).toEqual({ sessionId: 'session-a', through: 12 })
    scope.value = 'turn'
    scope.dispatchEvent(new Event('change'))
    expect(cuts.at(-1)).toBeUndefined()
    expect(host.querySelector('[data-stage="ledger"]')?.textContent).toContain('第 2 轮')
    expect(cursor.max).toBe('8')
    // A different session resets the mode and clears the cut before any interaction.
    scope.value = 'all'
    scope.dispatchEvent(new Event('change'))
    host.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
    expect(cuts.at(-1)).toEqual({ sessionId: 'session-a', through: 1 })
    graph.update(turnEvents('turn-x', 1), 'session-b')
    expect(cuts.at(-1)).toBeUndefined()
    expect(scope.value).toBe('turn')
    expect(status(host)).toBe('实时 · #9')
    // Disposing the graph releases the conversation.
    scope.value = 'all'
    scope.dispatchEvent(new Event('change'))
    host.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
    expect(cuts.at(-1)).toEqual({ sessionId: 'session-b', through: 1 })
    graph.dispose()
    expect(cuts.at(-1)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    graph.dispose()
    vi.useRealTimers()
  }
})

it('forwards the conversation cut through the read-only trace and clears it on reselect and dispose', async () => {
  const events = multiTurnFixture()
  const call = vi.fn().mockResolvedValue({ events, lastSeq: 21, nextAfterSeq: null })
  const cuts: Array<JevReplayCut | undefined> = []
  const host = document.createElement('section')
  const trace = createRuntimeRecordTrace(host, { call } as unknown as Pick<Client, 'call'>, undefined, {
    onCut: (cut) => cuts.push(cut),
    t,
  })
  trace.select('session-a', 21)
  await vi.waitFor(() =>
    expect(host.querySelector('.runtime-trace-coverage')?.textContent).toContain('完整账本前缀 #0–21'),
  )
  expect(cuts).toEqual([])
  const scope = host.querySelector<HTMLSelectElement>('[aria-label="Jev 回放范围"]')!
  scope.value = 'all'
  scope.dispatchEvent(new Event('change'))
  host.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
  expect(cuts.at(-1)).toEqual({ sessionId: 'session-a', through: 1 })
  trace.select('session-b', 0)
  expect(cuts.at(-1)).toBeUndefined()
  scope.value = 'all'
  scope.dispatchEvent(new Event('change'))
  host.querySelector<HTMLButtonElement>('[aria-label="从头回放"]')!.click()
  expect(cuts.at(-1)).toBeUndefined()
  trace.dispose()
  expect(cuts.at(-1)).toBeUndefined()
})
