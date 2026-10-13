import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultIds, type Event, type EventInput, SessionLogImpl, UIProjectionCell } from '@agnes/core'
import { UI_PROJECTION_DEFAULT_MAX_BYTES } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStorage } from '../src/adapters/storage-sqlite.js'
import {
  createStoredOpeningReader,
  openStoredOpeningReader,
  StoredOpeningError,
} from '../src/stored-opening.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const timers = {
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t: unknown) => globalThis.clearTimeout(t as never),
}
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const user = (content: unknown[]): EventInput => ({
  actor,
  origin: 'principal',
  trust: 'trusted',
  type: 'user/message',
  data: { content } as never,
})
const answer = (text: string): EventInput => ({
  actor: { ...actor, id: 'agent', role: 'agent' },
  origin: 'model',
  trust: 'untrusted',
  type: 'assistant/message',
  data: { content: [{ type: 'text', text }], stopReason: 'end_turn' },
})

async function writeSession(dir: string, key: string, image: string): Promise<string> {
  const file = join(dir, 'sessions.db')
  const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
  const log = await SessionLogImpl.open({
    storage,
    key,
    writerRunId: 'writer',
    ttlMs: 60_000,
    ids: defaultIds(),
    clock: () => Date.now(),
    timers,
  })
  for (let i = 0; i < 30; i++)
    await log.append([user([{ type: 'text', text: `question ${i}` }]), answer(`answer ${i}`)])
  await log.append([
    user([
      { type: 'text', text: 'look at this' },
      { type: 'image', mimeType: 'image/png', data: image },
    ]),
  ])
  await log.close()
  await storage.close()
  return file
}

/** The control: every row read lean from the writer's adapter, folded in one cell. */
async function control(dir: string, key: string, maxNodes: number) {
  const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  try {
    const { lastSeq } = await storage.open(key, { writerRunId: 'control', ttlMs: 60_000 })
    const cell = new UIProjectionCell(key, 'main')
    for (let from = 1; from <= lastSeq; from += 500)
      cell.apply(
        (await storage.scanLean(key, {
          fromSeq: from,
          toSeq: Math.min(lastSeq, from + 499),
          limit: 500,
        })) as Event[],
      )
    cell.sealReplay()
    await storage.release(key, 'control')
    return {
      lastSeq,
      opening: await cell.opening({ maxNodes, maxBytes: UI_PROJECTION_DEFAULT_MAX_BYTES }),
    }
  } finally {
    await storage.close()
  }
}

describe('stored opening reader', () => {
  it('folds the stored rows lean into the same bounded opening, without the image bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:stored'
    const image = randomBytes(400 * 1024).toString('base64')
    const file = await writeSession(dir, key, image)

    const reader = createStoredOpeningReader({ file })
    try {
      const result = await reader.opening(key, 200)
      const expected = await control(dir, key, 200)
      const timeline = result.timeline as { nodes: unknown[] }
      expect(timeline.nodes.length).toBeGreaterThan(30)
      expect(timeline.nodes.length).toBe(expected.opening.timeline.nodes.length)
      expect(result.timeline).toEqual(expected.opening.timeline)
      expect(result.hasEarlier).toBe(expected.opening.hasEarlier)
      expect(result.lastSeq).toBe(expected.lastSeq)
      const text = JSON.stringify(result)
      for (let at = 0; at + 64 <= image.length; at += 4096)
        expect(text).not.toContain(image.slice(at, at + 64))
    } finally {
      reader.close()
    }
  })

  it('reads while another connection holds the writer lease and an open write transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:leased'
    const file = await writeSession(dir, key, 'QUJD')
    const writer = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    const locker = new DatabaseSync(file)
    const reader = createStoredOpeningReader({ file })
    try {
      const { lastSeq } = await writer.open(key, { writerRunId: 'live-writer', ttlMs: 60_000 })
      // A real write lock with an uncommitted change in the WAL: the read sees the committed state.
      locker.exec('BEGIN IMMEDIATE')
      locker.prepare("UPDATE events SET ts = '2000-01-01T00:00:00.000Z' WHERE session_key = ?").run(key)
      const started = Date.now()
      const result = await reader.opening(key, 5)
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(result.lastSeq).toBe(lastSeq)
      expect((result.timeline as { nodes: unknown[] }).nodes).toHaveLength(5)
      expect(result.hasEarlier).toBe(true)
      expect(JSON.stringify(result)).not.toContain('2000-01-01')
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
      reader.close()
      await writer.release(key, 'live-writer')
      await writer.close()
    }
  })

  it('leans base64 attachments in SQL, before any row reaches JavaScript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:sql-lean'
    const image = randomBytes(400 * 1024).toString('base64')
    const file = await writeSession(dir, key, image)
    const raw: string[] = []
    const reader = openStoredOpeningReader({ file, onPage: (rows) => raw.push(JSON.stringify(rows)) })
    try {
      await reader.opening(key, 200)
      expect(raw.join('')).toContain('dataOmitted')
      expect(raw.join('')).not.toContain(image.slice(0, 64))
    } finally {
      reader.close()
    }
  })

  it('leans attachment data the SQL leaves whole with the JavaScript rule', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:js-lean'
    // Not ASCII, so the SQL rewrite leaves it; only the JS pass can omit it.
    const data = 'é'.repeat(300_000)
    const file = await writeSession(dir, key, 'QUJD')
    const db = new DatabaseSync(file)
    const row = db
      .prepare('SELECT seq, data FROM events WHERE session_key = ? ORDER BY seq DESC LIMIT 1')
      .get(key) as { seq: number; data: string }
    const last = JSON.parse(row.data) as { content: Array<{ type: string; data?: string }> }
    for (const block of last.content) if (block.type === 'image') block.data = data
    db.prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = ?').run(
      JSON.stringify(last),
      key,
      row.seq,
    )
    db.close()
    const raw: string[] = []
    const reader = openStoredOpeningReader({ file, onPage: (rows) => raw.push(JSON.stringify(rows)) })
    try {
      const result = await reader.opening(key, 200)
      expect(raw.join('')).toContain(data.slice(0, 64))
      expect(JSON.stringify(result)).not.toContain(data.slice(0, 64))
    } finally {
      reader.close()
    }
  })

  it('cuts pages by stored bytes, so large rows yield the event loop more often', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:paging'
    const file = await writeSession(dir, key, 'QUJD')
    const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    const log = await SessionLogImpl.open({
      storage,
      key,
      writerRunId: 'writer',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers,
    })
    for (let i = 0; i < 6; i++)
      await log.append([
        user([{ type: 'image', mimeType: 'image/png', data: randomBytes(300 * 1024).toString('base64') }]),
      ])
    await log.close()
    await storage.close()
    const pages: number[] = []
    const reader = openStoredOpeningReader({
      file,
      pageBytes: 1024 * 1024,
      onPage: (rows) => pages.push(rows.length),
    })
    try {
      const result = await reader.opening(key, 200)
      // 61 small rows, then six ~400 KiB rows: at most two big rows a page, never an empty page.
      expect(pages.length).toBeGreaterThanOrEqual(3)
      expect(pages.every((n) => n >= 1)).toBe(true)
      expect(pages.slice(1).every((n) => n <= 2)).toBe(true)
      expect(pages.reduce((a, b) => a + b, 0)).toBe(result.lastSeq)
    } finally {
      reader.close()
    }
    // A budget smaller than any row still moves one row a page.
    const single: number[] = []
    const tiny = openStoredOpeningReader({ file, pageBytes: 1, onPage: (rows) => single.push(rows.length) })
    try {
      const result = await tiny.opening(key, 200)
      expect(single.every((n) => n === 1)).toBe(true)
      expect(single).toHaveLength(result.lastSeq)
    } finally {
      tiny.close()
    }
    const whole: number[] = []
    const defaults = openStoredOpeningReader({ file, onPage: (rows) => whole.push(rows.length) })
    try {
      await defaults.opening(key, 200)
      expect(whole).toEqual([67])
    } finally {
      defaults.close()
    }
  })

  it('lets concurrent requests for one session share a single read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:shared'
    const file = await writeSession(dir, key, 'QUJD')
    let pages = 0
    const reader = openStoredOpeningReader({ file, onPage: () => pages++ })
    try {
      const [a, b] = await Promise.all([reader.opening(key, 200), reader.opening(key, 5)])
      expect(pages).toBe(1)
      expect((a.timeline as { nodes: unknown[] }).nodes.length).toBeGreaterThan(5)
      expect((b.timeline as { nodes: unknown[] }).nodes).toHaveLength(5)
      expect(a.lastSeq).toBe(b.lastSeq)
      // Done is done: a later request reads again.
      await reader.opening(key, 5)
      expect(pages).toBe(2)
    } finally {
      reader.close()
    }
  })

  it('refuses a session whose stored ancestry loops or runs too deep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:loop'
    const file = await writeSession(dir, key, 'QUJD')
    const db = new DatabaseSync(file)
    const insert = db.prepare(
      'INSERT INTO sessions (session_key, format_version, parent_key, boundary_seq, created_at) VALUES (?, 1, ?, 1, ?)',
    )
    insert.run('loop-a', 'loop-b', 'now')
    insert.run('loop-b', 'loop-a', 'now')
    for (let i = 0; i < 70; i++) insert.run(`deep-${i}`, `deep-${i + 1}`, 'now')
    db.prepare('UPDATE sessions SET parent_key = ?, boundary_seq = 1 WHERE session_key = ?').run(key, key)
    db.close()
    const reader = createStoredOpeningReader({ file })
    try {
      for (const id of ['loop-a', 'deep-0', key])
        await expect(reader.opening(id, 5)).rejects.toBeInstanceOf(StoredOpeningError)
    } finally {
      reader.close()
    }
  })

  it('opens the database read-only, so it never creates one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const file = join(dir, 'sessions.db')
    expect(() => createStoredOpeningReader({ file })).toThrow()
    expect(existsSync(file)).toBe(false)
  })

  it('folds a child session with its parent prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-stored-opening-'))
    dirs.push(dir)
    const key = 'agnes:local:default:cli:workspace:parent'
    const file = await writeSession(dir, key, 'QUJD')
    const storage = createSqliteStorage({ file, tablesDir: join(dir, 'tables') })
    const parent = await SessionLogImpl.open({
      storage,
      key,
      writerRunId: 'writer',
      ttlMs: 60_000,
      ids: defaultIds(),
      clock: () => Date.now(),
      timers,
    })
    const childKey = `${key}:child`
    const child = await parent.forkInto(10, childKey, {
      actor,
      agnesVersion: '0.0.0-test',
      preset: null,
      resolvedProfileHash: null,
      writerRunId: 'child',
      lane: 'main',
    })
    await child.append([user([{ type: 'text', text: 'child question' }])])
    await child.close()
    await parent.close()
    await storage.close()

    const reader = createStoredOpeningReader({ file })
    try {
      const result = await reader.opening(childKey, 200)
      const expected = await control(dir, childKey, 200)
      expect(result.timeline).toEqual(expected.opening.timeline)
      expect(result.lastSeq).toBe(expected.lastSeq)
    } finally {
      reader.close()
    }
  })
})
