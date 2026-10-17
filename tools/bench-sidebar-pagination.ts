// Synthetic SQL projection benchmark; no user database or live session workers are opened.
import { performance } from 'node:perf_hooks'
import type { EventEnvelope } from '@agnes/protocol'
import { SessionWorkspaceIndex } from '../packages/daemon-foundation/src/storage/lister.js'
import { SessionPrincipalOwnershipIndex } from '../packages/daemon-foundation/src/storage/session-ownership.js'
import { SessionPreferencesStore } from '../packages/daemon-foundation/src/storage/session-preferences.js'
import { SidebarSessions } from '../packages/daemon-foundation/src/storage/sidebar-sessions.js'
import type { TableHandle } from '../packages/daemon-foundation/src/storage/table.js'
import { WorkspaceIndex, workspaceIdFor } from '../packages/daemon-foundation/src/storage/workspaces.js'
import { sqliteTables } from '../packages/daemon-foundation/test/sqlite-tables.js'

const tables = sqliteTables(),
  raw = tables.table('session_workspaces')
let capture = false
const reads: { sql: string; params: unknown[]; rows: number }[] = []
const table: TableHandle = {
  ...raw,
  all: <T>(sql: string, params: unknown[] = []) => {
    const result = raw.all<T>(sql, params)
    if (capture) reads.push({ sql, params, rows: result.length })
    return result
  },
}
const sessions = new SessionWorkspaceIndex(table),
  owners = new SessionPrincipalOwnershipIndex(table)
new SessionPreferencesStore(table)
new WorkspaceIndex(table).put({ path: '/synthetic', name: 'synthetic' }, '2026-01-01T00:00:00Z')
const pages = new SidebarSessions(table, sessions),
  groupId = workspaceIdFor('/synthetic')
let populated = 0
try {
  for (const count of [1000, 10000]) {
    for (; populated < count; populated++) {
      const key = `session-${String(populated).padStart(5, '0')}`
      owners.bindNew(key, 'synthetic-owner')
      sessions.put(key, '/synthetic')
      sessions.observe(key, {
        seq: 1,
        type: 'session/start',
        lane: 'main',
        ts: '2026-01-01T00:00:00Z',
        data: {},
      } as EventEnvelope)
      owners.activateNew(key, 'synthetic-owner')
    }
    capture = true
    reads.length = 0
    const times: number[] = []
    let cursor: string | undefined
    const ids = new Set<string>()
    for (let page = 0; page < 100; page++) {
      const start = performance.now()
      const result = await pages.list('synthetic-owner', { groupId, ...(cursor ? { cursor } : {}) })
      times.push(performance.now() - start)
      if (result.total !== count || result.items.length !== 5) throw new Error('invalid SQL page')
      for (const item of result.items) {
        if (ids.has(item.sessionId)) throw new Error('duplicate session')
        ids.add(item.sessionId)
      }
      cursor = result.next
    }
    capture = false
    const query = reads.at(-1)!
    const plan = raw
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${query.sql}`, query.params)
      .map((row) => row.detail)
    if (
      plan.some((detail) => /TEMP B-TREE/.test(detail)) ||
      !plan.some((detail) => /sidebar_order/.test(detail))
    )
      throw new Error(`unexpected pagination plan: ${plan.join('; ')}`)
    if (reads.some((query) => query.rows > 6)) throw new Error('unbounded list read')
    times.sort((a, b) => a - b)
    console.log(
      JSON.stringify({
        sessions: count,
        pages: times.length,
        p50Ms: times[49],
        p95Ms: times[94],
        maxMs: times.at(-1),
        maxRowsRead: Math.max(...reads.map((row) => row.rows)),
        plan,
      }),
    )
  }
} finally {
  await pages.close()
  await tables.close()
}
