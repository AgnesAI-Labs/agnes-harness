import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { type HistoryIndex, openHistoryIndex } from '../src/store.js'

const dirs: string[] = []
const indexes: HistoryIndex[] = []

afterEach(() => {
  for (const index of indexes.splice(0)) index.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-history-sync-'))
  dirs.push(dir)
  return dir
}

/** A ledger shaped like the daemon's: keyed events and a sessions row per session. */
function ledger(dir: string) {
  const db = new DatabaseSync(join(dir, 'sessions.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
    origin TEXT NOT NULL, trust TEXT NOT NULL, source_event_seqs TEXT, data TEXT NOT NULL,
    PRIMARY KEY (session_key, seq))`)
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT PRIMARY KEY, parent_key TEXT, created_at TEXT NOT NULL)`)
  const insert = db.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const tail = db.prepare('SELECT MAX(seq) AS seq FROM events WHERE session_key = ?')
  const next = (key: string) => ((tail.get(key) as { seq: number | null }).seq ?? 0) + 1
  return {
    session(key: string, parent: string | null = null) {
      db.prepare('INSERT INTO sessions (session_key, parent_key, created_at) VALUES (?, ?, ?)').run(
        key,
        parent,
        `2026-02-01T00:00:00Z#${key}`,
      )
    },
    say(key: string, text: string, sources?: number[], id?: string) {
      const seq = next(key)
      insert.run(
        key,
        seq,
        `2026-02-01T00:${String(seq).padStart(2, '0')}:00Z`,
        id ?? `${key}:${seq}`,
        'user/message',
        'user',
        'untrusted',
        sources ? JSON.stringify(sources) : null,
        JSON.stringify({ content: [{ type: 'text', text }] }),
      )
    },
    reply(key: string, text: string) {
      const seq = next(key)
      insert.run(
        key,
        seq,
        `2026-02-01T01:${String(seq).padStart(2, '0')}:00Z`,
        `${key}:${seq}`,
        'assistant/message',
        'model',
        'untrusted',
        null,
        JSON.stringify({ content: [{ type: 'text', text }] }),
      )
    },
    title(key: string, title: string) {
      const seq = next(key)
      insert.run(
        key,
        seq,
        '2026-02-01T02:00:00Z',
        `${key}:${seq}`,
        'x/host/session-title',
        'system',
        'trusted',
        null,
        JSON.stringify({ status: 'generated', title }),
      )
    },
    discard(key: string) {
      db.prepare('DELETE FROM events WHERE session_key = ?').run(key)
      db.prepare('DELETE FROM sessions WHERE session_key = ?').run(key)
    },
    many(key: string, count: number) {
      db.exec('BEGIN')
      for (let n = 0; n < count; n++) this.say(key, `bulk line ${n} kestrel`)
      db.exec('COMMIT')
    },
    close: () => db.close(),
  }
}

function side(dir: string) {
  mkdirSync(join(dir, 'tables'), { recursive: true })
  const db = new DatabaseSync(join(dir, 'tables', 'daemon.db'))
  db.exec(
    'CREATE TABLE IF NOT EXISTS session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT)',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS session_principal_ownership (session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL)',
  )
  db.exec('CREATE TABLE IF NOT EXISTS session_preferences (session_key TEXT PRIMARY KEY, title TEXT)')
  return {
    workspace: (key: string, cwd: string, title: string | null = null) =>
      db.prepare('INSERT OR REPLACE INTO session_workspaces VALUES (?, ?, ?)').run(key, cwd, title),
    owner: (key: string, principal: string) =>
      db.prepare('INSERT OR REPLACE INTO session_principal_ownership VALUES (?, ?)').run(key, principal),
    rename: (key: string, title: string) =>
      db.prepare('INSERT OR REPLACE INTO session_preferences VALUES (?, ?)').run(key, title),
    forget: (key: string) => {
      db.prepare('DELETE FROM session_workspaces WHERE session_key = ?').run(key)
      db.prepare('DELETE FROM session_principal_ownership WHERE session_id = ?').run(key)
    },
    close: () => db.close(),
  }
}

function open(path: string): HistoryIndex {
  const index = openHistoryIndex(path)
  indexes.push(index)
  return index
}

/** Everything a search can see, plus a check that the FTS index matches its content table. */
function dump(path: string) {
  const db = new DatabaseSync(path)
  try {
    db.exec(`INSERT INTO docs_fts(docs_fts, rank) VALUES ('integrity-check', 1)`)
    return {
      sessions: db
        .prepare(
          `SELECT session_id, workspace, title, created_at, parent_id, principal, indexed_seq, indexed_id,
           first_ts, generated_title, prompt FROM sessions ORDER BY session_id`,
        )
        .all(),
      docs: db
        .prepare(
          'SELECT session_id, seq, ts, type, text, body, sources, truncated FROM docs ORDER BY session_id, seq',
        )
        .all(),
      hits: ['kestrel', 'bridge', 'Harbor', 'later'].map((term) =>
        db
          .prepare(
            `SELECT d.session_id, d.seq FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
             WHERE docs_fts MATCH ? ORDER BY d.session_id, d.seq`,
          )
          .all(`"${term}"`),
      ),
    }
  } finally {
    db.close()
  }
}

/** The incremental index must equal one built from nothing over the same ledger. */
function expectFresh(dir: string, incremental: string): void {
  const fresh = join(tempDir(), 'history-index.db')
  open(fresh).sync(dir)
  expect(dump(incremental)).toEqual(dump(fresh))
}

describe('incremental history sync', () => {
  it('matches a fresh build after appends, titles, renames, discards and a rewritten session', () => {
    const dir = tempDir()
    const book = ledger(dir)
    const tables = side(dir)
    book.session('a')
    book.say('a', 'alpha bridge repair')
    book.reply('a', 'the bridge needs bolts')
    book.session('b', 'a')
    book.say('b', 'kestrel nest survey')
    tables.workspace('a', '/work/a')
    tables.workspace('b', '/work/a', 'Workspace title')
    tables.owner('a', 'owner-a')
    tables.owner('b', 'owner-a')
    const path = join(dir, 'history-index.db')
    const index = open(path)
    expect(index.sync(dir)).toEqual({ generation: 1, synced: true })
    expectFresh(dir, path)

    book.title('a', 'Harbor plans')
    book.say('a', 'later question', [1])
    book.session('c')
    book.reply('c', 'no prompt yet')
    expect(index.sync(dir)).toEqual({ generation: 1, synced: true })
    expectFresh(dir, path)

    book.say('c', 'first prompt arrives later')
    tables.rename('b', 'Renamed kestrel work')
    expect(index.sync(dir).generation).toBe(1)
    expectFresh(dir, path)

    book.discard('b')
    tables.forget('b')
    expect(index.sync(dir).generation).toBe(2)
    expectFresh(dir, path)

    book.discard('c')
    book.session('c')
    book.say('c', 'rewritten kestrel', undefined, 'c:new')
    expect(index.sync(dir).generation).toBe(3)
    expectFresh(dir, path)
    book.close()
    tables.close()
  })

  it('reads a session longer than one batch across transactions, and a second handle adds no duplicates', () => {
    const dir = tempDir()
    const book = ledger(dir)
    book.session('long')
    book.many('long', 4500)
    const path = join(dir, 'history-index.db')
    const first = open(path)
    first.sync(dir)
    book.many('long', 10)
    const second = open(path)
    second.sync(dir)
    book.say('long', 'one more kestrel')
    first.sync(dir)
    expect(second.sync(dir).synced).toBe(false)
    const counted = dump(path)
    expect(counted.docs.filter((doc) => doc.session_id === 'long' && Number(doc.seq) >= 1)).toHaveLength(4511)
    expectFresh(dir, path)
    book.close()
  })

  it('keeps an indexed session without ledger rows while a side table still names it, like a fresh build', () => {
    const dir = tempDir()
    const book = ledger(dir)
    const tables = side(dir)
    book.session('kept')
    book.say('kept', 'kestrel before the discard')
    tables.workspace('kept', '/work/a', 'Side title')
    const path = join(dir, 'history-index.db')
    const index = open(path)
    index.sync(dir)
    book.discard('kept')
    expect(index.sync(dir).generation).toBe(2)
    expect(
      dump(path)
        .docs.filter((doc) => doc.session_id === 'kept')
        .map((doc) => doc.seq),
    ).toEqual([-1])
    expectFresh(dir, path)
    book.close()
    tables.close()
  })
})
