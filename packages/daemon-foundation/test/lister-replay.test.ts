import type { EventEnvelope } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { SessionWorkspaceIndex } from '../src/storage/lister.js'
import type { TableHandle, Tables } from '../src/storage/table.js'
import { sqliteTables } from './sqlite-tables.js'
import { sequential } from './workspace-fold-reference.js'

// Opening a session replays its whole history through observe(). Rows that already folded those
// events must not be rewritten: each rewrite takes the database write lock the worker also needs.

const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 0, minute)).toISOString()
const event = (seq: number, type: string, data: unknown): EventEnvelope =>
  ({ seq, type, ts: at(seq), data, lane: 'main' }) as EventEnvelope
const text = (value: string) => ({ content: [{ type: 'text', text: value }] })

function history(length: number): EventEnvelope[] {
  const events = [event(1, 'session/start', { key: 's', preset: 'standard', resolvedProfileHash: 'p1' })]
  for (let seq = 2; seq <= length; seq++) {
    const kind = seq % 4
    events.push(
      kind === 0
        ? event(seq, 'x/core/preset-switch', { to: seq % 8 === 0 ? 'standard' : 'careful' })
        : event(seq, kind === 1 ? 'user/message' : 'assistant/message', text(`message ${seq}`)),
    )
  }
  return events
}

const opened: Tables[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((tables) => tables.close()))
})

function index() {
  const tables = sqliteTables()
  opened.push(tables)
  const table = tables.table('session_workspaces')
  let writes = 0
  const counting: TableHandle = {
    ...table,
    exec(sql, params) {
      writes++
      table.exec(sql, params)
    },
  }
  const workspaces = new SessionWorkspaceIndex(counting)
  workspaces.put('s', '/repo')
  return {
    workspaces,
    row: () =>
      table.get<Record<string, unknown>>('SELECT * FROM session_workspaces WHERE session_key = ?', ['s']),
    writes: () => writes,
    reset: () => {
      writes = 0
    },
    table,
  }
}

it('replaying projected history writes nothing and leaves the row as it was', () => {
  const { workspaces, row, writes, reset } = index()
  const events = history(40)
  for (const e of events) workspaces.observe('s', e, 3)
  const projected = row()
  expect(projected).toMatchObject({ last_seq: 40, message_seq: 40, generation: 3 })
  reset()
  for (const e of events) workspaces.observe('s', e, 3)
  expect(writes()).toBe(0)
  expect(row()).toEqual(projected)
})

it('a replay from a newer worker generation records the generation once', () => {
  const { workspaces, row, writes, reset } = index()
  const events = history(40)
  for (const e of events) workspaces.observe('s', e, 3)
  const projected = row()
  reset()
  for (const e of events) workspaces.observe('s', e, 4)
  expect(writes()).toBe(1)
  expect(row()).toEqual({ ...projected, generation: 4 })
})

it('events past the projection are still folded', () => {
  const { workspaces, writes, reset } = index()
  for (const e of history(40)) workspaces.observe('s', e, 3)
  reset()
  workspaces.observe('s', event(41, 'user/message', text('new question')), 3)
  expect(writes()).toBeGreaterThan(0)
  expect(workspaces.metadata('s')).toMatchObject({ lastSeq: 41, lastActiveAt: at(41) })
})

it('a projection behind its message sequence still catches up from a replay', () => {
  const { workspaces, row, table } = index()
  const events = history(40)
  for (const e of events) workspaces.observe('s', e, 3)
  const projected = row()
  table.exec('UPDATE session_workspaces SET message_seq = 10 WHERE session_key = ?', ['s'])
  for (const e of events) workspaces.observe('s', e, 3)
  expect(row()).toEqual(projected)
})

it('a row without its session start is still filled in by a replay', () => {
  const { workspaces, table } = index()
  const events = history(12)
  for (const e of events) workspaces.observe('s', e, 3)
  table.exec("UPDATE session_workspaces SET created_at = NULL, loop_pin = NULL WHERE session_key = 's'")
  for (const e of events) workspaces.observe('s', e, 3)
  expect(workspaces.metadata('s')?.createdAt).toBe(at(1))
})

it('a row whose sort key predates the column is repaired by a replay', () => {
  const { workspaces, row, table } = index()
  const events = history(12)
  for (const e of events) workspaces.observe('s', e, 3)
  const projected = row()
  table.exec("UPDATE session_workspaces SET sidebar_sort_at = 0 WHERE session_key = 's'")
  for (const e of events) workspaces.observe('s', e, 3)
  expect(row()).toEqual(projected)
})

for (const column of ['title', 'last_active_at']) {
  it(`an empty stored ${column} is still normalised to null by a replay`, () => {
    const { workspaces, row, table } = index()
    const events = history(12)
    for (const e of events) workspaces.observe('s', e, 3)
    const projected = row()
    table.exec(`UPDATE session_workspaces SET ${column} = '' WHERE session_key = 's'`)
    for (const e of events) workspaces.observe('s', e, 3)
    expect(row()).toEqual({ ...projected, [column]: null })
  })
}

it('a row whose last sequence fell behind is brought forward by a replay', () => {
  const { workspaces, row, table } = index()
  const events = history(40)
  for (const e of events) workspaces.observe('s', e, 3)
  const projected = row()
  table.exec("UPDATE session_workspaces SET last_seq = 5 WHERE session_key = 's'")
  for (const e of events) workspaces.observe('s', e, 3)
  expect(row()).toEqual(projected)
})

for (const [createdAt, sortAt] of [
  [at(1), Date.parse(at(1))],
  ['not a date', 0],
] as const) {
  it(`a stale sort key without messages is recomputed from created_at ${JSON.stringify(createdAt)}`, () => {
    const { workspaces, row, table } = index()
    const start = history(1)
    for (const e of start) workspaces.observe('s', e, 3)
    table.exec("UPDATE session_workspaces SET created_at = ?, sidebar_sort_at = 7 WHERE session_key = 's'", [
      createdAt,
    ])
    for (const e of start) workspaces.observe('s', e, 3)
    expect(row()).toMatchObject({ message_at: null, sidebar_sort_at: sortAt })
  })
}

it('a replayed session start restores a missing loop pin', () => {
  const { workspaces, row, table } = index()
  const loop = { id: 'agnes/default', version: '1.0.0' }
  const events = [event(1, 'session/start', { key: 's', preset: 'standard', loop }), ...history(12).slice(1)]
  for (const e of events) workspaces.observe('s', e, 3)
  table.exec("UPDATE session_workspaces SET created_at = NULL, loop_pin = NULL WHERE session_key = 's'")
  for (const e of events) workspaces.observe('s', e, 3)
  expect(row()).toMatchObject({ created_at: at(1), loop_pin: JSON.stringify(loop) })
})

it('skipping a replayed event never leaves a row the full fold would have changed', () => {
  // Differential check against the unconditional fold over row states a replay can meet.
  const states: Record<string, unknown>[] = [
    {},
    { title: 'named', last_active_at: at(3) },
    { title: '', last_active_at: null },
    { preset: null, profile_hash: '' },
    { created_at: 'not a date' },
    { created_at: null },
    { message_at: null, sidebar_sort_at: 0 },
    { sidebar_sort_at: 0 },
    { message_seq: 3 },
    { last_seq: 3 },
    { generation: 1 },
  ]
  for (const state of states) {
    for (const generation of [0, 3, 4]) {
      for (const replayed of history(8)) {
        const rows = [index(), index()].map((store) => {
          for (const e of history(8)) store.workspaces.observe('s', e, 3)
          for (const [column, value] of Object.entries(state))
            store.table.exec(`UPDATE session_workspaces SET ${column} = ? WHERE session_key = 's'`, [value])
          return store
        })
        const [skipping, folding] = rows as [ReturnType<typeof index>, ReturnType<typeof index>]
        skipping.workspaces.observe('s', replayed, generation)
        sequential(folding.table, 's', replayed, generation, true)
        expect(skipping.row(), JSON.stringify({ state, generation, seq: replayed.seq })).toEqual(
          folding.row(),
        )
      }
    }
  }
})
