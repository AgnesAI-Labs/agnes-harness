import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkRelations } from '../src/log/relations.js'
import { ChunkedMap } from '../src/reduce/chunked-map.js'
import { foldEvents, initialState, reduce } from '../src/reduce/reducer.js'
import type { LedgerState } from '../src/reduce/state.js'
import { StateTracker } from '../src/reduce/tracker.js'
import { canonicalJson } from '../src/request/hash.js'
import type { Event } from '../src/types.js'
import { encodeLedgerState } from '../testkit/encode-ledger-state.js'
import { TRANSITION_SCENARIOS } from '../testkit/record-transitions.js'
import { goldenLedger, toolHeavyLedger } from '../testkit/tool-heavy-ledger.js'

const encode = (state: LedgerState) => canonicalJson(encodeLedgerState(state))

/** Every table of a state by name, registers included. */
const tables = (s: LedgerState): Map<string, unknown> =>
  new Map<string, unknown>([
    ...Object.entries(s.registers).map(([k, v]) => [`registers.${k}`, v] as [string, unknown]),
    ...Object.entries(s).filter(
      ([k]) =>
        k !== 'registers' &&
        k !== 'session' &&
        typeof s[k as keyof LedgerState] === 'object' &&
        s[k as keyof LedgerState] !== null,
    ),
  ])

const crashDir = fileURLToPath(new URL('../fixtures/crash/', import.meta.url))
const ledgers: [string, () => Iterable<Event>][] = [
  ...TRANSITION_SCENARIOS.map(
    (name) => [`golden ${name}`, () => goldenLedger(name)] as [string, () => Iterable<Event>],
  ),
  ...readdirSync(crashDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map(
      (name) =>
        [
          `crash ${name}`,
          () =>
            readFileSync(`${crashDir}${name}`, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as Event),
        ] as [string, () => Iterable<Event>],
    ),
  ['300 tool calls', () => toolHeavyLedger({ calls: 300 })],
]

describe('a fold step never changes the state it was given', () => {
  it.each(ledgers)(
    '%s',
    (_name, rows) => {
      let prev = initialState()
      for (const row of rows()) {
        const before = encode(prev)
        const was = tables(prev)
        const next = reduce(prev, row)
        expect(encode(prev), `row ${row.seq} (${row.type})`).toBe(before)
        // A table is either shared untouched or replaced by a copy; which one, the encoding above
        // already proves safe. The chunked tables stay chunked whatever the row.
        for (const [name, table] of tables(prev))
          expect(table, `${name} at row ${row.seq}`).toBe(was.get(name))
        expect(next.toolCalls).toBeInstanceOf(ChunkedMap)
        expect(next.decisions).toBeInstanceOf(ChunkedMap)
        prev = next
      }
    },
    60_000,
  )

  it('starts and forks with chunked growing tables', () => {
    expect(initialState().toolCalls).toBeInstanceOf(ChunkedMap)
    expect(initialState().decisions).toBeInstanceOf(ChunkedMap)
    const state = foldEvents(toolHeavyLedger({ calls: 30 }))
    const [first] = toolHeavyLedger({ calls: 1 })
    const forked = reduce(state, {
      ...(first as Event),
      seq: state.lastSeq + 1,
      data: {
        key: 'child',
        parent: { key: 'k', boundarySeq: state.lastSeq },
        resolvedProfileHash: null,
        preset: 'standard',
        agnesVersion: '0.0.1',
      },
    } as Event)
    expect(forked.toolCalls).toBeInstanceOf(ChunkedMap)
    expect(forked.toolCalls.size).toBe(0)
    expect(forked.decisions).toBeInstanceOf(ChunkedMap)
    expect(state.toolCalls.size).toBe(30)
  })
})

describe('the relation check simulates a batch without touching the live state', () => {
  it('leaves the tracker state as it was, whether the batch passes or is refused', () => {
    const tracker = new StateTracker()
    const all = [...toolHeavyLedger({ calls: 1001 })]
    const head = all.filter((row) => row.seq <= 19_000)
    const rest = all.filter((row) => row.seq > 19_000)
    tracker.apply(head)
    const state = tracker.state
    const before = encode(state)
    // The next rows as the append path would check them: a turn boundary, a step with its call, its
    // result and its settled effects.
    checkRelations(rest.slice(0, 60), state)
    expect(tracker.state).toBe(state)
    expect(encode(state)).toBe(before)
    const orphan = {
      ...(rest.find((row) => row.type === 'tool/result') as Event),
      seq: undefined,
      data: { toolUseId: 'never-called', content: [], isError: false },
      sourceEventSeqs: undefined,
    }
    expect(() => checkRelations([...rest.slice(0, 20), orphan as never], state)).toThrow(
      /E_RELATION|tool\/result/,
    )
    expect(encode(state)).toBe(before)
  })
})
