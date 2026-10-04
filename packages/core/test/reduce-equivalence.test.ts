import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { initialState, reduce } from '../src/reduce/reducer.js'
import type { LedgerState } from '../src/reduce/state.js'
import { canonicalJson } from '../src/request/hash.js'
import type { Event } from '../src/types.js'
import { encodeLedgerState } from '../testkit/encode-ledger-state.js'
import { TRANSITION_SCENARIOS } from '../testkit/record-transitions.js'
import { goldenLedger, toolHeavyLedger } from '../testkit/tool-heavy-ledger.js'
import * as reference from './helpers/reference-reducer.js'

// The reference folds into plain Maps and Sets; encoding reads either the same way.
type AnyState = LedgerState | reference.LedgerState
const encode = (state: AnyState) => canonicalJson(encodeLedgerState(state as LedgerState))

type Outcome<S> = { state: S } | { error: string }
const step = <S>(fold: (s: S, e: Event) => S, s: S, e: Event): Outcome<S> => {
  try {
    return { state: fold(s, e) }
  } catch (error) {
    return { error: String(error) }
  }
}

/** Folds `rows` with both reducers, comparing the encoded state at every row `every` rows apart and the last. */
function compare(rows: Iterable<Event>, every = 1): number {
  let ours = initialState()
  let theirs = reference.initialState()
  let n = 0
  let last: Event | undefined
  for (const row of rows) {
    last = row
    const a = step(reduce, ours, row)
    const b = step(reference.reduce, theirs, row)
    if ('error' in a || 'error' in b) {
      expect(a, `row ${row.seq} (${row.type})`).toEqual(b)
      throw new Error(`both reducers refused row ${row.seq} (${row.type}): ${'error' in a ? a.error : ''}`)
    }
    ours = a.state
    theirs = b.state
    n++
    if (n % every === 0) expect(encode(ours), `row ${row.seq} (${row.type})`).toBe(encode(theirs))
  }
  if (last) expect(encode(ours)).toBe(encode(theirs))
  return n
}

const crashDir = fileURLToPath(new URL('../fixtures/crash/', import.meta.url))
const crash = readdirSync(crashDir).filter((name) => name.endsWith('.jsonl'))
const readLedger = (path: string): Event[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)

it('reconstructs generic output ownership from the real answer ledger and clears it at a fork boundary', () => {
  const capture = JSON.parse(
    readFileSync(new URL('./fixtures/jev-real-answer-preview.json', import.meta.url), 'utf8'),
  ) as { events: Event[] }
  const requested = capture.events.find((event) => event.seq === 47)
  if (!requested) throw new Error('Missing real answer request')
  const anchor = {
    ...requested,
    seq: 48,
    type: 'assistant/output',
    sourceEventSeqs: [47],
    data: {
      state: 'started',
      effectId: 'portable-output',
      chars: { text: 0, thinking: 0 },
      estimatedTokens: 0,
    },
  } as Event
  const rows = capture.events.flatMap((event) =>
    event.seq <= 47
      ? [event, ...(event.seq === 47 ? [anchor] : [])]
      : [
          {
            ...event,
            seq: event.seq + 1,
            ...(event.sourceEventSeqs
              ? {
                  sourceEventSeqs: event.sourceEventSeqs
                    .map((source) => (source >= 48 ? source + 1 : source))
                    .concat(event.type === 'assistant/message' ? [48] : []),
                }
              : {}),
          } as Event,
        ],
  )
  compare(rows)
  let state = initialState()
  for (const event of rows) state = reduce(state, event)
  expect(state.assistantOutputs.get(48)?.closed).toBe(true)
  const fork = {
    ...capture.events[0],
    seq: rows.length + 1,
    data: {
      ...(capture.events[0]?.data as object),
      key: 'presentation-child',
      runtime: { id: 'native', version: '1' },
      parent: { key: 'agnes:jev-answer-preview-fixture', boundarySeq: rows.length },
    },
  } as Event
  compare([...rows, fork])
  const child = reduce(state, fork)
  expect(child.assistantOutputs.size).toBe(0)
  expect(child.lastRuntimeRecord.size).toBe(0)
  expect(state.assistantOutputs.get(48)?.closed).toBe(true)
})

/** 50 tool calls, then a fork child's start at the head, then two more calls with fresh ids. */
function* forkedAfterToolCalls(): Generator<Event> {
  let last = 0
  for (const row of toolHeavyLedger({ calls: 50 })) {
    last = row.seq
    yield row
  }
  const start = { ...(toolHeavyLedger({ calls: 1 }).next().value as Event) }
  yield {
    ...start,
    seq: last + 1,
    data: {
      key: 'child',
      parent: { key: 'tool-heavy', boundarySeq: last },
      resolvedProfileHash: null,
      preset: 'standard',
      agnesVersion: '0.0.1',
    },
  } as Event
  for (const row of toolHeavyLedger({ calls: 2 })) {
    if (row.type === 'session/start') continue
    const text = JSON.stringify(row).replaceAll('t-call-', 't-child-').replaceAll('"e-', '"child-e-')
    const moved = JSON.parse(text) as Event
    yield {
      ...moved,
      seq: moved.seq + last,
      ...(moved.sourceEventSeqs ? { sourceEventSeqs: moved.sourceEventSeqs.map((seq) => seq + last) } : {}),
    }
  }
}

describe('the fold matches the reference reducer row for row', () => {
  it('a fork started after tool calls', () => {
    expect(compare(forkedAfterToolCalls())).toBeGreaterThan(1000)
  })

  for (const name of TRANSITION_SCENARIOS)
    it(`golden recording ${name}`, () => {
      expect(compare(goldenLedger(name))).toBeGreaterThan(0)
    })
  for (const name of crash)
    it(`crash fixture ${name}`, () => {
      expect(compare(readLedger(`${crashDir}${name}`))).toBeGreaterThan(0)
    })
  it('a thousand-call tool-heavy ledger', () => {
    expect(compare(toolHeavyLedger({ calls: 1000 }), 97)).toBeGreaterThan(19_000)
  })
})
