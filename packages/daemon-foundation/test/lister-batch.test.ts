import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { SessionWorkspaceIndex } from '../src/storage/lister.js'
import type { TableHandle, Tables } from '../src/storage/table.js'
import { sqliteTables } from './sqlite-tables.js'
import { sequential } from './workspace-fold-reference.js'

// A batched replay folds its events into the row in memory and writes once when the batch ends.
// The written row must equal what folding the same events one UPDATE at a time produces.

const opened: Tables[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((tables) => tables.close()))
})

function counted() {
  const tables = sqliteTables()
  opened.push(tables)
  const table = tables.table('session_workspaces')
  const count = { reads: 0, writes: 0 }
  const handle: TableHandle = {
    ...table,
    get(sql, params) {
      if (/FROM session_workspaces WHERE session_key/.test(sql)) count.reads++
      return table.get(sql, params)
    },
    exec(sql, params) {
      if (/^\s*UPDATE session_workspaces/.test(sql)) {
        count.writes++
      }
      table.exec(sql, params)
    },
  }
  const index = new SessionWorkspaceIndex(handle)
  index.put('s', '/repo')
  count.reads = 0
  count.writes = 0
  return {
    index,
    table,
    count,
    row: () =>
      table.get<Record<string, unknown>>('SELECT * FROM session_workspaces WHERE session_key = ?', ['s']),
  }
}

function referenceRow(events: Array<[EventEnvelope, number]>, setup?: (table: TableHandle) => void) {
  const tables = sqliteTables()
  opened.push(tables)
  const table = tables.table('session_workspaces')
  new SessionWorkspaceIndex(table).put('s', '/repo')
  setup?.(table)
  for (const [event, generation] of events) sequential(table, 's', event, generation)
  return table.get<Record<string, unknown>>('SELECT * FROM session_workspaces WHERE session_key = ?', ['s'])
}

/** A small deterministic generator so failures replay. */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function randomHistory(seed: number, length: number): EventEnvelope[] {
  const next = random(seed)
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)] as T
  const events: EventEnvelope[] = []
  const base = Date.UTC(2026, 9, 21)
  for (let seq = 1; seq <= length; seq++) {
    // Timestamps are not monotonic: the sort key must take the newest, not the last.
    const ts = new Date(base + Math.floor(next() * 1000) * 60_000).toISOString()
    const envelope = (type: string, data: unknown, extra: Partial<EventEnvelope> = {}) =>
      ({
        seq,
        ts,
        type,
        data,
        lane: 'main',
        origin: 'principal',
        trust: 'trusted',
        ...extra,
      }) as EventEnvelope
    const kind =
      seq === 1 ? 'start' : pick(['user', 'assistant', 'empty', 'switch', 'title', 'start', 'other', 'side'])
    if (kind === 'start')
      events.push(
        envelope('session/start', {
          key: next() < 0.5 ? 's' : 'parent',
          preset: pick(['standard', 'careful', undefined]),
          resolvedProfileHash: pick(['p1', 'p2', undefined]),
          ...(next() < 0.5 ? { loop: { id: pick(['agnes', 'other']), version: pick(['1', '2']) } } : {}),
        }),
      )
    else if (kind === 'user' || kind === 'assistant')
      events.push(envelope(`${kind}/message`, { content: [{ type: 'text', text: `message ${seq}` }] }))
    else if (kind === 'empty')
      events.push(envelope('user/message', { content: [{ type: 'text', text: ' ' }] }))
    else if (kind === 'switch')
      events.push(envelope('x/core/preset-switch', { to: pick(['standard', 'careful']) }))
    else if (kind === 'title')
      events.push(
        envelope(
          'x/host/session-title',
          {
            turn: 1,
            startSeq: 1,
            route: 'r',
            model: 'm',
            prompt: 'p',
            budgetCap: null,
            treeBudgetCap: null,
            status: 'generated',
            title: `title ${seq}`,
          },
          { origin: 'system', ignorable: true },
        ),
      )
    else if (kind === 'side')
      events.push(
        envelope('assistant/message', { content: [{ type: 'text', text: 'side' }] }, { lane: 'side' }),
      )
    else events.push(envelope('tool/call', { name: 'read' }))
  }
  return events
}

it('folds a replay into the same row as one UPDATE per event, across random histories', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const history = randomHistory(seed, 40 + (seed % 7) * 13)
    const generations = history.map((_, i) => (seed % 3 === 0 && i > history.length / 2 ? 2 : 1))
    // A first replay of a prefix, then a full replay with a repeated stretch, as an open after a restart.
    const cut = Math.floor(history.length * ((seed % 5) / 5))
    const first = history.slice(0, cut).map((e) => [e, 1] as [EventEnvelope, number])
    const second = [
      ...history.map((e, i) => [e, generations[i] as number] as [EventEnvelope, number]),
      ...history.slice(cut).map((e, i) => [e, generations[cut + i] as number] as [EventEnvelope, number]),
    ]
    const { index, row } = counted()
    const replay = (events: Array<[EventEnvelope, number]>) => {
      for (const [event, generation] of events) index.observe('s', event, generation)
    }
    // Odd seeds fold the first pass one event at a time, even seeds batch both passes.
    if (seed % 2) replay(first)
    else index.batch('s', () => replay(first))
    index.batch('s', () => replay(second))
    expect(row(), `seed ${seed}`).toEqual(referenceRow([...first, ...second]))
  }
})

it('catches a lagging row up with one write', () => {
  const history = randomHistory(7, 2_000)
  const { index, count, row } = counted()
  index.batch('s', () => {
    for (const event of history) index.observe('s', event, 1)
    expect(count).toEqual({ reads: 1, writes: 0 })
  })
  expect(count.reads).toBe(2)
  expect(count.writes).toBeLessThanOrEqual(2)
  expect(row()).toEqual(referenceRow(history.map((e) => [e, 1])))
})

it('replays a caught-up row with one read and no writes', () => {
  const history = randomHistory(11, 2_000)
  const { index, count, row } = counted()
  index.batch('s', () => {
    for (const event of history) index.observe('s', event, 1)
  })
  const projected = row()
  count.reads = 0
  count.writes = 0
  index.batch('s', () => {
    for (const event of history) index.observe('s', event, 1)
  })
  expect(count).toEqual({ reads: 1, writes: 0 })
  expect(row()).toEqual(projected)
})

it('folds a newer generation even below the folded bound', () => {
  const history = randomHistory(9, 50)
  const { index, row } = counted()
  for (const event of history) index.observe('s', event, 1)
  index.batch('s', () => {
    index.observe('s', history[0] as EventEnvelope, 1)
    index.observe('s', history[1] as EventEnvelope, 3)
  })
  expect(row()).toMatchObject({ generation: 3 })
})

it('writes the events observed before a batch fails, as one UPDATE per event would have', () => {
  const history = randomHistory(13, 60)
  const { index, row } = counted()
  expect(() =>
    index.batch('s', () => {
      for (const event of history.slice(0, 30)) index.observe('s', event, 1)
      throw new Error('incomplete session history')
    }),
  ).toThrow('incomplete session history')
  expect(row()).toEqual(referenceRow(history.slice(0, 30).map((e) => [e, 1])))
})

it('folds other sessions immediately while one session is batching', () => {
  const history = randomHistory(15, 20)
  const { index, table } = counted()
  index.put('other', '/repo')
  index.batch('s', () => {
    for (const event of history) index.observe('other', event, 1)
    expect(index.metadata('other')?.lastSeq).toBe(20)
  })
  expect(
    table.get<{ n: number }>('SELECT last_seq AS n FROM session_workspaces WHERE session_key = ?', ['s'])?.n,
  ).toBe(0)
})

it('a refresh catches up with one write per page', async () => {
  const history = randomHistory(17, 1_200)
  const { index, count, row } = counted()
  await index.refresh(
    's',
    {
      status: async () => ({ lastSeq: history.length, preset: null }),
      scan: async (q) =>
        history.filter((e) => e.seq >= q.fromSeq && e.seq <= q.toSeq).slice(0, q.limit ?? 500),
    },
    1,
  )
  // Three pages of up to two writes each, plus the final generation and preset update.
  expect(count.writes).toBeLessThanOrEqual(7)
  expect(row()).toEqual(referenceRow(history.map((e) => [e, 1])))
})

it('sorts a session without messages by the start it folded', () => {
  const start = {
    seq: 1,
    ts: '2026-10-21T08:00:00.000Z',
    type: 'session/start',
    data: { key: 's', preset: 'standard' },
    lane: 'main',
  } as unknown as EventEnvelope
  const { index, row } = counted()
  index.observe('s', start, 1)
  expect(row()).toMatchObject({ sidebar_sort_at: Date.parse(start.ts) })
  expect(row()).toEqual(referenceRow([[start, 1]]))
})
