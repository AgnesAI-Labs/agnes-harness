import { ok } from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionPreferencesStore,
  withSessionPreferences,
} from '@agnes/daemon-foundation/storage/session-preferences'
import { withSessionPromptTitles } from '@agnes/daemon-foundation/storage/sidebar-sessions'
import { createSqliteStorage } from '@agnes/host-infrastructure/adapters/storage-sqlite'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { MemorySessionWorkspaces, SessionWorkspaceIndex } from '../src/storage/lister.js'
import { supervisorLister } from '../src/supervisor/supervisor.js'

// No live workers: every row comes from the durable workspace projection.
const idle = {
  keys: () => [],
  get: () => undefined,
  status: async () => ({ lastSeq: 0, preset: null }),
} as never

const event = (seq: number, type: string, ts: string) =>
  ({
    seq,
    ts,
    id: `id-${seq}`,
    type,
    data:
      type === 'session/start' ? { preset: 'standard', loop: { id: 'example.dag', version: '1.0.0' } } : {},
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
  }) as never

function seeded(): MemorySessionWorkspaces {
  const workspaces = new MemorySessionWorkspaces()
  const add = (key: string, created: string, chatted?: string) => {
    workspaces.put(key, '/w')
    workspaces.observe(key, event(1, 'session/start', created))
    if (chatted) workspaces.observe(key, event(2, 'user/message', chatted))
  }
  add('c-old-chatted-now', '2026-09-01T00:00:00.000Z', '2026-09-21T10:00:00.000Z')
  add('a-new-silent', '2026-09-21T09:00:00.000Z')
  add('b-tie', '2026-09-20T00:00:00.000Z')
  add('a-tie', '2026-09-20T00:00:00.000Z')
  add('z-chatted-long-ago', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z')
  // Bound but not yet projected: no creation time to rank by.
  workspaces.put('no-projection', '/w')
  return workspaces
}

const expected = [
  'c-old-chatted-now',
  'a-new-silent',
  'a-tie',
  'b-tie',
  'z-chatted-long-ago',
  'no-projection',
]

describe('supervisorLister', () => {
  it('restores unopened cloud titles from a reopened projection and preserves manual names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-title-'))
    let storage = createSqliteStorage({ file: join(root, 'sessions.db') })
    const table = () => {
      const t = storage.tables('@agnes/daemon').table('session_workspaces')
      return {
        exec: (sql: string, params: unknown[] = []) => {
          if (params.length) t.run(sql, params)
          else t.exec(sql)
        },
        get: <T>(sql: string, params: unknown[] = []) => t.get<T>(sql, params),
        all: <T>(sql: string, params: unknown[] = []) => t.all<T>(sql, params),
        transaction: <T>(fn: () => T) => t.transaction(fn),
      }
    }
    try {
      let t = table()
      const index = new SessionWorkspaceIndex(t)
      t.exec(
        'CREATE TABLE history (session_key TEXT, seq INTEGER, event TEXT, PRIMARY KEY (session_key, seq))',
      )
      for (const key of ['demo', 'failed', 'renamed', 'foreign']) {
        index.put(key, '/repo')
        const history: EventEnvelope[] = [
          event(1, 'session/start', '2026-11-20T00:00:00Z'),
          {
            ...(event(2, 'user/message', '2026-11-20T00:00:00Z') as EventEnvelope),
            data: { content: [{ type: 'text', text: key === 'demo' ? 'ooo' : '你好' }] },
            lane: 'main',
          },
        ]
        for (const row of history) {
          index.observe(key, row)
          t.exec('INSERT INTO history VALUES (?, ?, ?)', [key, row.seq, JSON.stringify(row)])
        }
      }
      new SessionPreferencesStore(t).rename('renamed', '手动标题')
      await storage.close()
      storage = createSqliteStorage({ file: join(root, 'sessions.db') })
      t = table()
      let unavailable = true
      const scan = vi.fn(async (key: string, query: { fromSeq?: number; toSeq?: number; limit: number }) => {
        if (key === 'failed' && unavailable) throw new Error('temporarily unavailable')
        return t
          .all<{ event: string }>(
            'SELECT event FROM history WHERE session_key = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?',
            [key, query.fromSeq ?? 1, query.toSeq ?? Number.MAX_SAFE_INTEGER, query.limit],
          )
          .map((row) => JSON.parse(row.event) as EventEnvelope)
      })
      // The flat cloud frame uses supervisorLister through session.list, not grouped sidebar.list.
      const lister = withSessionPromptTitles(
        withSessionPreferences(
          supervisorLister(idle, new SessionWorkspaceIndex(t)),
          new SessionPreferencesStore(t),
        ),
        scan,
      )
      const ordinary = await lister.list({ sessionIds: ['demo', 'failed', 'renamed'] })
      expect(ordinary.items.find((row) => row.sessionId === 'demo')?.title).toBeUndefined()
      expect(scan).not.toHaveBeenCalled()
      const first = await lister.list({
        includePromptTitles: true,
        sessionIds: ['demo', 'failed', 'renamed'],
        limit: 1,
      })
      expect(first.items.map((row) => [row.sessionId, row.title])).toEqual([['demo', 'ooo']])
      expect(scan.mock.calls.map(([key]) => key)).toEqual(['demo'])
      ok(first.cursor, 'Expected another page of cloud sessions')
      const next = {
        includePromptTitles: true,
        sessionIds: ['demo', 'failed', 'renamed'],
        limit: 2,
        cursor: first.cursor,
      }
      const partial = await lister.list(next)
      expect(partial.items).toHaveLength(2)
      expect(partial.items[0]?.title).toBeUndefined()
      unavailable = false
      const second = await lister.list(next)
      expect(second.items.map((row) => [row.sessionId, row.title])).toEqual([
        ['failed', '你好'],
        ['renamed', '手动标题'],
      ])
      expect(scan.mock.calls.map(([key]) => key)).not.toContain('foreign')
      expect(scan.mock.calls.map(([key]) => key)).not.toContain('renamed')
      const reads = scan.mock.calls.length
      await lister.list({ includePromptTitles: true, sessionIds: ['demo', 'failed', 'renamed'] })
      expect(scan.mock.calls.length).toBe(reads)
    } finally {
      await storage.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports the permission a live worker runs under and leaves projected rows without one', async () => {
    const live = {
      keys: () => ['a-new-silent'],
      get: (key: string) => (key === 'a-new-silent' ? { generation: 2, session: { lastSeq: 1 } } : undefined),
      status: async () => ({ lastSeq: 1, preset: 'standard', permission: 'full-access' }),
    } as never
    const page = await supervisorLister(live, seeded()).list({ limit: 50 })
    expect(page.items.find((row) => row.sessionId === 'a-new-silent')).toMatchObject({
      preset: 'standard',
      permission: 'full-access',
    })
    expect(page.items.find((row) => row.sessionId === 'b-tie')).not.toHaveProperty('permission')
  })

  it('orders by the latest user message, then creation time, ties and unprojected rows last', async () => {
    const page = await supervisorLister(idle, seeded()).list({ limit: 50 })
    expect(page.items.map((row) => row.sessionId)).toEqual(expected)
    expect(page.cursor).toBeUndefined()
    expect(page.items[0]?.loop).toEqual({ id: 'example.dag', version: '1.0.0' })
    expect(page.items.at(-1)?.loop).toBeUndefined()
  })

  it('pages through the recency order without repeating or skipping a row', async () => {
    const lister = supervisorLister(idle, seeded())
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await lister.list({ limit: 2, ...(cursor ? { cursor } : {}) })
      seen.push(...page.items.map((row) => row.sessionId))
      cursor = page.cursor
    } while (cursor)
    expect(seen).toEqual(expected)
  })

  it('rejects a cursor it did not issue, including the old bare-key form', async () => {
    const lister = supervisorLister(idle, seeded())
    for (const cursor of ['a-tie', '[1,2]', '["only-one"]'])
      await expect(lister.list({ cursor })).rejects.toMatchObject({
        code: -32602,
        data: { code: 'INVALID_PARAMS' },
      })
  })

  it('applies the owner scope before ordering', async () => {
    const page = await supervisorLister(idle, seeded()).list({
      sessionIds: ['z-chatted-long-ago', 'a-new-silent'],
    })
    expect(page.items.map((row) => row.sessionId)).toEqual(['a-new-silent', 'z-chatted-long-ago'])
  })
})
