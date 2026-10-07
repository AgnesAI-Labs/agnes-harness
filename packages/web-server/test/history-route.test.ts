import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { handleHistorySearch } from '../src/history-route.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-history-route-'))
  dirs.push(dir)
  const ledger = new DatabaseSync(join(dir, 'sessions.db'))
  ledger.exec(`CREATE TABLE events (
    session_key TEXT, seq INTEGER, ts TEXT, id TEXT, type TEXT, origin TEXT, trust TEXT,
    source_event_seqs TEXT, data TEXT
  )`)
  ledger.exec(`CREATE TABLE sessions (session_key TEXT PRIMARY KEY, parent_key TEXT, created_at TEXT)`)
  ledger
    .prepare(
      `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
       VALUES ('mine', 1, 't', 'mine:1', 'user/message', 'user', 'untrusted', NULL, ?)`,
    )
    .run(JSON.stringify({ text: 'alpha bridge repair' }))
  ledger.close()
  mkdirSync(join(dir, 'tables'))
  const side = new DatabaseSync(join(dir, 'tables', 'daemon.db'))
  side.exec(`CREATE TABLE session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT)`)
  side.exec(
    `CREATE TABLE session_principal_ownership (session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL)`,
  )
  side
    .prepare(`INSERT INTO session_workspaces (session_key, cwd, title) VALUES (?, ?, ?)`)
    .run('mine', '/work/a', 'Bridge notes')
  side
    .prepare(`INSERT INTO session_principal_ownership (session_id, principal_id) VALUES (?, ?)`)
    .run('mine', 'owner-a')
  side.close()
  return dir
}

const origin = 'http://127.0.0.1:4177'

function call(dir: string, search: string, extra: { method?: string; origin?: string; site?: string } = {}) {
  return handleHistorySearch({
    method: extra.method ?? 'GET',
    search,
    origin: extra.origin === undefined ? origin : extra.origin,
    site: extra.site ?? 'same-origin',
    expectedOrigin: origin,
    dataDir: dir,
  })
}

describe('history search route', () => {
  it('searches the ledger for the sole owner and pages the list', () => {
    const dir = seed()
    const found = call(dir, '?q=alpha+bridge&title=Bridge&workspace=/work/a')
    expect(found.status).toBe(200)
    expect(found.body).toMatchObject({ items: [{ sessionId: 'mine', title: 'Bridge notes' }] })
    const page = call(dir, '?workspace=/work/a')
    expect(page.status).toBe(200)
    const body = page.body as { items: unknown[]; next?: string }
    expect(body.items.length).toBeGreaterThan(0)
  })

  it('rejects a cross-site request, a non-GET, and a second owner', () => {
    const dir = seed()
    expect(call(dir, '?q=alpha', { site: 'cross-site' }).status).toBe(403)
    expect(call(dir, '?q=alpha', { method: 'POST' }).status).toBe(405)
    const side = new DatabaseSync(join(dir, 'tables', 'other.db'))
    side.exec(`CREATE TABLE session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL)`)
    side.exec(
      `CREATE TABLE session_principal_ownership (session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL)`,
    )
    side.prepare(`INSERT INTO session_workspaces (session_key, cwd) VALUES ('extra', '/work/a')`).run()
    side
      .prepare(
        `INSERT INTO session_principal_ownership (session_id, principal_id) VALUES ('extra', 'owner-c')`,
      )
      .run()
    side.close()
    expect(call(dir, '').body).toEqual({ error: { code: 'MULTIPLE_OWNERS' } })
  })
})
