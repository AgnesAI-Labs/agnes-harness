import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LEAN_DATA_MIN_CHARS, leanEvents } from '@agnes/core'
import { afterEach, expect, it } from 'vitest'
import { createSqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { EVENT_COLUMNS_LEAN_READ, LEAN_DATA_COLUMN } from '../../src/adapters/storage-sqlite-lean.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const big = 'QUJD'.repeat(LEAN_DATA_MIN_CHARS / 4 + 1)
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const shapes: unknown[] = [
  {
    content: [
      { type: 'text', text: 'é😀"\\' },
      { type: 'image', mimeType: 'image/jpeg', data: big },
    ],
  },
  {
    kind: 'prompt',
    content: [{ type: 'file', mimeType: 'application/zip', name: 'a"b.zip', data: `${big}QQ==` }],
  },
  { content: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }] },
  { content: [] },
  { note: 'no content key at all', pad: big },
  {
    content: [
      { type: 'image', mimeType: 'image/jpeg', data: big },
      { type: 'image', mimeType: 'image/jpeg', data: big },
    ],
  },
]
const inbox = {
  items: [
    { itemId: 'a', content: [{ type: 'image', mimeType: 'image/jpeg', data: big }] },
    { itemId: 'b', content: [{ type: 'text', text: 't' }] },
    { itemId: 'c' },
  ],
}

it('rewrites rows in SQL exactly as the JS rule does, without changing stored rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-lean-'))
  dirs.push(dir)
  const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  await storage.open('k', { writerRunId: 'w', ttlMs: 60_000 })
  const events = [
    ...shapes.map((data) => ({
      ts: '2026-10-13T00:00:00.000Z',
      id: 'x',
      lane: 'main',
      v: 1,
      actor,
      origin: 'principal',
      trust: 'trusted',
      type: 'user/message',
      data,
    })),
    {
      ts: '2026-10-13T00:00:00.000Z',
      id: 'y',
      lane: 'main',
      v: 1,
      actor,
      origin: 'system',
      trust: 'trusted',
      type: 'inbox',
      register: 'inbox',
      data: inbox,
    },
    {
      ts: '2026-10-13T00:00:00.000Z',
      id: 'z',
      lane: 'main',
      v: 1,
      actor,
      origin: 'tool:read',
      trust: 'trusted',
      type: 'tool/result',
      data: { content: [{ type: 'image', mimeType: 'image/png', data: big }] },
    },
  ]
  await storage.commit('k', { events: events as never, expectedWriterRunId: 'w' })
  const q = { fromSeq: 1, toSeq: events.length, limit: 500 }
  const full = await storage.scan('k', q)
  const lean = await storage.scanLean('k', q)
  expect(lean.map((e) => JSON.stringify(e))).toEqual(leanEvents(full).map((e) => JSON.stringify(e)))
  expect((await storage.scan('k', q)).map((e) => JSON.stringify(e))).toEqual(
    full.map((e) => JSON.stringify(e)),
  )
  await storage.close()
})

// Rows a valid ledger should not hold, but storage does not refuse: the SQL rewrite must still agree
// with the JS rule on every one of them, down to the last byte.
const edge = 'QUJD'.repeat(LEAN_DATA_MIN_CHARS / 4)
const odd: unknown[] = [
  {
    content: [
      1,
      0.30000000000000004,
      12345678901234567000,
      1e21,
      -0,
      true,
      false,
      null,
      's',
      [1, { a: 2 }],
      { type: 'image', mimeType: 'image/png', data: big },
    ],
  },
  {
    content: [
      { type: 'text', text: '\ud800 lone \udfff and \u0000 nul' },
      { type: 'image', mimeType: 'image/png', data: big },
    ],
  },
  {
    content: [
      { type: 'image', mimeType: 'image/png', data: edge },
      { type: 'image', mimeType: 'image/png', data: `${edge}A` },
    ],
  },
  { content: [{ type: 'image', mimeType: 'image/png', data: '😀'.repeat(LEAN_DATA_MIN_CHARS / 2 + 1) }] },
  { content: [{ type: 'image', mimeType: 'image/png', data: '😀'.repeat(LEAN_DATA_MIN_CHARS + 1) }] },
  {
    content: [{ type: 'file', mimeType: 'text/plain', name: 'é', data: 'é'.repeat(LEAN_DATA_MIN_CHARS + 1) }],
  },
  { content: [{ type: 'image', mimeType: 'image/png', data: `${big}\u0000==` }] },
  {
    content: [
      { type: 'image', mimeType: 'image/png', data: 7, pad: big },
      { type: 'file', name: 'n', pad: big },
      { type: 'audio', data: big },
    ],
  },
  { content: [{ type: 'image', dataOmitted: { bytes: 1 }, mimeType: 'image/png', data: big, after: true }] },
  { content: { type: 'image', mimeType: 'image/png', data: big } },
  [{ type: 'image', mimeType: 'image/png', data: big }],
  big,
  { 'a.b': { $: 1 }, content: [{ type: 'image', mimeType: 'image/png', data: `${big}=` }], z: 1.5e-7 },
]
const oddInbox: unknown[] = [
  {
    items: [
      1,
      'x',
      null,
      [{ type: 'image', data: big }],
      { content: 'no' },
      { itemId: 'q', content: [{ type: 'image', mimeType: 'image/png', data: big }, 2] },
    ],
  },
  { items: { content: [{ type: 'image', mimeType: 'image/png', data: big }] } },
]

it('agrees with the JS rule on malformed and boundary shapes, for a child reading its parent prefix too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-lean-'))
  dirs.push(dir)
  const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  await storage.open('p', { writerRunId: 'w', ttlMs: 60_000 })
  const base = { ts: '2026-10-13T00:00:00.000Z', id: 'x', lane: 'main', v: 1, actor, trust: 'trusted' }
  const events = [
    ...odd.map((data) => ({ ...base, origin: 'principal', type: 'user/message', data })),
    // The awkward neighbours again, beside a block only the JS pass can finish.
    {
      ...base,
      origin: 'principal',
      type: 'user/message',
      data: { content: [{ ...awkward, data: 'é'.repeat(LEAN_DATA_MIN_CHARS + 1) }, awkward] },
    },
    ...oddInbox.map((data) => ({ ...base, origin: 'system', type: 'inbox', register: 'inbox', data })),
  ]
  await storage.commit('p', { events: events as never, expectedWriterRunId: 'w' })
  await storage.createChild('p', events.length, 'c')
  await storage.open('c', { writerRunId: 'w2', ttlMs: 60_000 })
  await storage.commit('c', {
    events: [{ ...base, origin: 'principal', type: 'user/message', data: shapes[0] }] as never,
    expectedWriterRunId: 'w2',
  })
  for (const key of ['p', 'c']) {
    const q = { fromSeq: 1, toSeq: events.length + 1, limit: 500 }
    const full = await storage.scan(key, q)
    const lean = await storage.scanLean(key, q)
    expect(lean.map((e) => JSON.stringify(e))).toEqual(leanEvents(full).map((e) => JSON.stringify(e)))
  }
  await expect(storage.scanLean('p', {})).rejects.toThrow(/E_SCAN_UNBOUNDED/)
  await expect(storage.scanLean('p', { limit: 0 })).rejects.toThrow(/E_SCAN_UNBOUNDED/)
  await storage.close()
})

// Base64 blocks whose neighbours, and whose own other keys, need exact re-rendering: every value and
// key the SQL carries over must come out as JSON.stringify would write it.
const awkward = {
  '0': 'integer-like key',
  '10': true,
  type: 'image',
  flag: false,
  nothing: null,
  big: 12345678901234567000,
  neg: -0,
  e: 1e21,
  tiny: 1.5e-7,
  real: 0.30000000000000004,
  '\u0001\u2028\u007f': 'ctl \u0001 \u2028 \u007f "q" \\ \n \t /',
  '\ud800': 'lone key',
  lone: '\udfff',
  'a"b\\c': [true, { '\ud800': -0 }],
  mimeType: 'image/png',
  data: big,
  dataOmitted: 'not an object',
  after: { nested: [1e21, false] },
}
const siblings: unknown[] = [
  {
    '1': 1e21,
    content: [awkward, { type: 'text', text: '\ud800\u2028' }, true, -0, 12345678901234567000],
    z: '\u007f',
  },
  { content: [{ ...awkward, type: 'file', name: '\u2028"', data: `${big}=` }, awkward] },
]
const siblingInbox = {
  items: [
    { '1': 'x', itemId: 'w', '\ud800': true, content: [awkward, false], tail: 1e21 },
    { itemId: 'v', z: -0 },
  ],
}

it('does the whole rewrite in SQL for base64 data, with nothing left for the JS pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-lean-'))
  dirs.push(dir)
  const file = join(dir, 'sessions.db')
  const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
  await storage.open('k', { writerRunId: 'w', ttlMs: 60_000 })
  const base = { ts: '2026-10-13T00:00:00.000Z', id: 'x', lane: 'main', v: 1, actor, trust: 'trusted' }
  const events = [
    ...[...shapes, ...siblings].map((data) => ({ ...base, origin: 'principal', type: 'user/message', data })),
    { ...base, origin: 'system', type: 'inbox', register: 'inbox', data: inbox },
    { ...base, origin: 'system', type: 'inbox', register: 'inbox', data: siblingInbox },
  ]
  await storage.commit('k', { events: events as never, expectedWriterRunId: 'w' })
  const full = await storage.scan('k', { fromSeq: 1, toSeq: events.length, limit: 500 })
  await storage.close()
  const db = new DatabaseSync(file, { readOnly: true })
  const rows = db
    .prepare(`SELECT type, ${LEAN_DATA_COLUMN} AS data FROM events ORDER BY seq`)
    .all() as Array<{ data: string }>
  db.close()
  expect(rows.map((r) => JSON.stringify(JSON.parse(r.data)))).toEqual(
    leanEvents(full).map((e) => JSON.stringify(e.data)),
  )
})

it('reads every column of the events table that rowToEvent reads, and names the rest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-lean-'))
  dirs.push(dir)
  const file = join(dir, 'sessions.db')
  const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
  await storage.close()
  const db = new DatabaseSync(file, { readOnly: true })
  const columns = (
    db.prepare('SELECT name FROM pragma_table_info(?)').all('events') as Array<{ name: string }>
  ).map((c) => c.name)
  db.close()
  // A column added to the table lands in neither list and fails here until it is placed.
  const unread = ['session_key', 'integrity_mode', 'integrity_prev', 'integrity_digest']
  expect([...columns].sort()).toEqual([...EVENT_COLUMNS_LEAN_READ, 'data', ...unread].sort())
})
