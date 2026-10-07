import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ExtensionAPI, ToolContext, ToolResult } from '@agnes/extension-api'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSessionQueryExtension,
  sessionEventReadTool,
  sessionEventSearchTool,
  sessionSearchTool,
  sessionTraceTool,
} from '../src/index.js'
import { closeSessionQuery, mountSessionQuery } from '../src/runtime.js'

const dirs: string[] = []
afterEach(() => {
  closeSessionQuery()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-session-query-'))
  dirs.push(dir)
  return dir
}

function seed(dir: string): void {
  const ledger = new DatabaseSync(join(dir, 'sessions.db'))
  ledger.exec(`CREATE TABLE events (
    session_key TEXT, seq INTEGER, ts TEXT, id TEXT, type TEXT, origin TEXT, trust TEXT,
    source_event_seqs TEXT, data TEXT
  )`)
  ledger.exec(`CREATE TABLE sessions (session_key TEXT PRIMARY KEY, parent_key TEXT, created_at TEXT)`)
  const event = ledger.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
     VALUES (?, ?, 't', ?, 'user/message', 'user', 'untrusted', ?, ?)`,
  )
  const session = ledger.prepare(
    `INSERT INTO sessions (session_key, parent_key, created_at) VALUES (?, ?, 't')`,
  )
  session.run('self', 'parent-secret')
  session.run('peer', null)
  session.run('other-owner', null)
  session.run('away', null)
  session.run('readerless', null)
  event.run('self', 2, 'self:2', null, JSON.stringify({ text: 'alpha bridge repair' }))
  event.run('peer', 1, 'peer:1', null, JSON.stringify({ text: 'alpha bridge repair extra' }))
  event.run('other-owner', 1, 'other:1', null, JSON.stringify({ text: 'alpha bridge repair secret' }))
  event.run('away', 1, 'away:1', null, JSON.stringify({ text: 'alpha bridge repair elsewhere' }))
  event.run('readerless', 1, 'open:1', null, JSON.stringify({ text: 'alpha bridge repair public' }))
  ledger.close()
  mkdirSync(join(dir, 'tables'))
  const side = new DatabaseSync(join(dir, 'tables', 'daemon.db'))
  side.exec(`CREATE TABLE session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL)`)
  side.exec(
    `CREATE TABLE session_principal_ownership (session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL)`,
  )
  const workspace = side.prepare(`INSERT INTO session_workspaces (session_key, cwd) VALUES (?, ?)`)
  const owner = side.prepare(
    `INSERT INTO session_principal_ownership (session_id, principal_id) VALUES (?, ?)`,
  )
  for (const [key, cwd] of [
    ['self', '/work/a'],
    ['peer', '/work/a'],
    ['other-owner', '/work/a'],
    ['away', '/work/b'],
    ['readerless', '/work/a'],
  ] as const) {
    workspace.run(key, cwd)
  }
  owner.run('self', 'owner-a')
  owner.run('peer', 'owner-a')
  owner.run('other-owner', 'owner-b')
  owner.run('away', 'owner-a')
  side.close()
}

function caller(workspaceRoot: string, cwd = workspaceRoot): ToolContext {
  return {
    session: { key: 'self', lane: 'main', workspaceRoot, toolUseId: 't', depth: 0, generationDepth: 0 },
    cwd,
    actor: { id: 'owner-b' },
  } as ToolContext
}

function text(result: ToolResult): string {
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('session query tools', () => {
  it('searches the caller workspace and omits the caller session', async () => {
    const dir = tempDir()
    seed(dir)
    mountSessionQuery(dir)
    const found = await sessionSearchTool.execute({ query: 'alpha bridge' }, caller('/work/a'))
    expect(found.isError).toBeUndefined()
    expect(text(found)).toContain('peer')
    expect(text(found)).toContain('readerless')
    expect(text(found)).not.toContain('session self')
    expect(text(found)).not.toContain('other-owner')
    expect(text(found)).not.toContain('away')
    expect(text(found)).not.toContain('secret')
    const byCwd = await sessionSearchTool.execute({ query: 'alpha bridge' }, caller('', '/work/a'))
    expect(text(byCwd)).toContain('peer')
  })

  it('uses one denial for a hidden session and a missing session', async () => {
    const dir = tempDir()
    seed(dir)
    mountSessionQuery(dir)
    const hidden = await sessionEventSearchTool.execute(
      { sessionId: 'other-owner', query: 'alpha' },
      caller('/work/a'),
    )
    const missing = await sessionEventSearchTool.execute(
      { sessionId: 'missing', query: 'alpha' },
      caller('/work/a'),
    )
    expect(text(hidden)).toBe('Not authorized to read that session.')
    expect(text(hidden)).toBe(text(missing))
    expect(hidden.isError).toBe(true)
    expect(text(hidden)).not.toContain('secret')
    const own = await sessionEventReadTool.execute({ sessionId: 'self', seq: 99 }, caller('/work/a'))
    expect(text(own)).toBe('Event not found.')
    const trace = await sessionTraceTool.execute({ sessionId: 'self' }, caller('/work/a'))
    expect(text(trace)).not.toContain('parent-secret')
    expect(text(trace)).toContain('[unavailable]')
  })

  it('reports an unmounted index and still loads when the ledger is absent', () => {
    const missing = sessionSearchTool.execute({ query: 'alpha' }, caller('/work/a'))
    return expect(missing).resolves.toMatchObject({
      isError: true,
      content: [{ text: 'History search is not mounted.' }],
    })
  })

  it('binds an empty data directory without throwing', () => {
    const dir = tempDir()
    const warnings: string[] = []
    const factory = createSessionQueryExtension({ dataDir: dir })
    const dispose = factory({
      registerTool: () => () => undefined,
      registerHook: () => () => undefined,
      ctx: {
        log: {
          debug() {},
          info() {},
          warn(message: string) {
            warnings.push(message)
          },
          error() {},
        },
      },
    } as unknown as ExtensionAPI)
    expect(warnings).toEqual([])
    expect(typeof dispose).toBe('function')
    if (typeof dispose === 'function') dispose()
  })
})
