import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSqliteStorage,
  type TableHandle as HostTable,
} from '@agnes/host-infrastructure/adapters/storage-sqlite'
import type { EventEnvelope } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { MemorySessionWorkspaces, SessionWorkspaceIndex } from '../src/storage/lister.js'
import { SessionPrincipalOwnershipIndex } from '../src/storage/session-ownership.js'
import { SessionPreferencesStore } from '../src/storage/session-preferences.js'
import { MemorySidebarSessions } from '../src/storage/sidebar-memory.js'
import { SidebarSessions } from '../src/storage/sidebar-sessions.js'
import type { TableHandle } from '../src/storage/table.js'
import { WorkspaceIndex, workspaceIdFor } from '../src/storage/workspaces.js'
import { sqliteTables } from './sqlite-tables.js'

const event = (
  seq: number,
  type = 'user/message',
  ts = '2026-10-16T00:00:00Z',
  data: unknown = { content: [{ type: 'text', text: 'hello' }] },
): EventEnvelope => ({ seq, type, ts, data, lane: 'main' }) as EventEnvelope
function setup(t: TableHandle, clock?: () => number) {
  const workspaces = new SessionWorkspaceIndex(t),
    ownership = new SessionPrincipalOwnershipIndex(t)
  const preferences = new SessionPreferencesStore(t, clock),
    registry = new WorkspaceIndex(t)
  const add = (key: string, cwd = '/repo', principal = 'owner', at = '2026-10-16T00:00:00Z') => {
    ownership.bindNew(key, principal)
    workspaces.put(key, cwd)
    workspaces.observe(key, event(1, 'session/start', '2026-10-15T00:00:00Z', { preset: 'standard' }))
    workspaces.observe(key, event(2, 'user/message', at))
    ownership.activateNew(key, principal)
  }
  registry.put({ path: '/repo', name: 'repo' }, '2026-10-15T00:00:00Z')
  return { workspaces, ownership, preferences, registry, add }
}
const adapt = (owner: HostTable): TableHandle => ({
  exec(sql, params = []) {
    if (params.length) owner.run(sql, params)
    else owner.exec(sql)
  },
  get: <T>(sql: string, params = []) => owner.get<T>(sql, params),
  all: <T>(sql: string, params = []) => owner.all<T>(sql, params),
  transaction: <T>(fn: () => T) => owner.transaction(fn),
})

it('projects only visible messages, compares UTC instants, and never regresses during replay', async () => {
  const tables = sqliteTables()
  try {
    for (const index of [
      new SessionWorkspaceIndex(tables.table('session_workspaces')),
      new MemorySessionWorkspaces(),
    ]) {
      index.put('s', '/repo')
      index.observe('s', event(1, 'session/start', '2026-10-15T00:00:00Z', { preset: 'standard' }))
      index.observe('s', event(2, 'user/message', '2026-10-16T08:00:00+08:00'))
      index.observe('s', event(3, 'assistant/message', '2026-10-16T00:01:00Z'))
      for (const [i, row] of [
        event(4, 'tool/result', '2026-10-17T00:00:00Z'),
        { ...event(5, 'assistant/message', '2026-10-17T00:00:00Z'), lane: 'other' },
        event(6, 'assistant/message', '2026-10-17T00:00:00Z', {
          content: [{ type: 'thinking', text: 'hidden' }],
        }),
        event(7, 'user/message', '2026-10-17T00:00:00Z', {
          content: [{ type: 'text', text: 'hidden context' }],
          kind: 'runtime_context',
        }),
      ].entries()) {
        index.observe('s', row as EventEnvelope)
        expect(index.metadata('s')?.lastSeq).toBe(4 + i)
      }
      expect(index.metadata('s')?.lastMessageAt).toBe('2026-10-16T00:01:00.000Z')
      index.observe(
        's',
        event(8, 'assistant/output', '2026-10-16T00:02:00Z', {
          state: 'interrupted',
          content: [{ type: 'text', text: 'partial' }],
        }),
      )
      index.observe('s', event(2, 'user/message', '2026-10-14T00:00:00Z'))
      expect(index.metadata('s')?.lastMessageAt).toBe('2026-10-16T00:02:00.000Z')
    }
  } finally {
    await tables.close()
  }
})

it.each(['sql', 'memory'])(
  'filters authorization and archive before paging, keeps ties stable, and rejects changed scope (%s)',
  async (kind) => {
    const tables = sqliteTables(),
      t = tables.table('session_workspaces'),
      s = setup(t)
    const makePages = () =>
      kind === 'sql'
        ? new SidebarSessions(t, s.workspaces)
        : new MemorySidebarSessions(s.workspaces, s.ownership, s.preferences, async () => ({
            items: s.registry.rows().map((row) => ({ ...row, sessionCount: 0, available: true })),
          }))
    const pages = makePages(),
      groupId = workspaceIdFor('/repo')
    try {
      for (let i = 0; i < 12; i++) s.add(`s${String(i).padStart(2, '0')}`)
      s.add('foreign', '/repo', 'other')
      s.preferences.archive('s11', true)
      s.ownership.bindNew('pending', 'owner')
      s.workspaces.put('pending', '/repo')
      s.add('unregistered', '/other')
      s.add('foreign-unregistered', '/other', 'other')
      const groups = await pages.groups('owner')
      expect(groups).toMatchObject({ ready: true })
      expect(groups.items.find((g) => g.groupId === groupId)?.total).toBe(11)
      expect(groups.items.find((g) => g.groupId === 'unassigned')?.total).toBe(1)
      const first = await pages.list('owner', { groupId })
      expect(first.items.map((x) => x.sessionId)).toEqual(['s10', 's09', 's08', 's07', 's06'])
      s.preferences.rename('s01', 'renamed') // Presentation alone does not expire an ordered page.
      s.preferences.rename('s01', 'renamed again')
      expect(() =>
        t.transaction(() => {
          s.preferences.archive('s10', true)
          throw new Error('rollback')
        }),
      ).toThrow('rollback')
      const second = await pages.list('owner', { groupId, cursor: first.next! })
      const third = await pages.list('owner', { groupId, cursor: second.next! })
      expect([...first.items, ...second.items, ...third.items].map((x) => x.sessionId)).toEqual(
        Array.from({ length: 11 }, (_, i) => `s${String(10 - i).padStart(2, '0')}`),
      )
      expect(third.next).toBeUndefined()
      await expect(pages.list('other', { groupId, cursor: first.next! })).rejects.toMatchObject({
        data: { code: 'SESSION_SIDEBAR_CURSOR_INVALID' },
      })
      await expect(pages.list('owner', { groupId: 'unassigned', cursor: first.next! })).rejects.toMatchObject(
        {
          data: { code: 'SESSION_SIDEBAR_CURSOR_INVALID' },
        },
      )
      await expect(pages.list('owner', { groupId, limit: 6 })).rejects.toMatchObject({
        data: { code: 'SESSION_SIDEBAR_LIMIT_INVALID' },
      })
      s.preferences.archive('s10', true)
      await expect(pages.list('owner', { groupId, cursor: first.next! })).rejects.toMatchObject({
        data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' },
      })
      const fresh = await pages.list('owner', { groupId })
      s.workspaces.observe('s00', event(3, 'assistant/message', '2026-10-17T00:00:00Z'))
      await expect(pages.list('owner', { groupId, cursor: fresh.next! })).rejects.toMatchObject({
        data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' },
      })
      expect((await pages.list('owner', { groupId })).items[0]?.sessionId).toBe('s00')
      if (kind === 'sql') {
        // A database initialized before reversible workspace removal still has the old trigger.
        t.exec('DROP TRIGGER sidebar_workspace_update')
        t.exec(`CREATE TRIGGER sidebar_workspace_update AFTER UPDATE ON workspace_registry
          WHEN OLD.path IS NOT NEW.path OR OLD.workspace_id IS NOT NEW.workspace_id BEGIN
          UPDATE session_workspaces SET sidebar_group = COALESCE(
            (SELECT workspace_id FROM workspace_registry WHERE path = cwd), 'unassigned')
            WHERE cwd IN (OLD.path, NEW.path); END`)
      }
      await expect(makePages().list('owner', { groupId, cursor: fresh.next! })).rejects.toMatchObject({
        data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' },
      })
      s.registry.remove(groupId, () => {
        for (const key of s.workspaces.keys())
          if (s.workspaces.get(key) === '/repo') s.preferences.archive(key, true)
      })
      expect((await pages.groups('owner')).items.some((group) => group.groupId === groupId)).toBe(false)
      await expect(pages.list('owner', { groupId })).rejects.toMatchObject({
        data: { code: 'SESSION_SIDEBAR_GROUP_INVALID' },
      })
      // A restored session remains reachable even before its removed workspace is added again.
      s.preferences.archive('s00', false)
      expect(
        (await pages.list('owner', { groupId: 'unassigned' })).items.map((row) => row.sessionId),
      ).toContain('s00')
      s.registry.put({ path: '/repo', name: 'repo' }, '2026-10-17T00:00:00Z')
      expect((await pages.list('owner', { groupId })).items.map((row) => row.sessionId)).toEqual(['s00'])
      await expect(pages.list('owner', { groupId, cursor: fresh.next! })).rejects.toMatchObject({
        data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' },
      })
    } finally {
      await pages.close()
      await tables.close()
    }
  },
)

it.each(['sql', 'memory'])(
  'reports the fork parent and boundary only on forked sessions, never across principals (%s)',
  async (kind) => {
    const tables = sqliteTables(),
      t = tables.table('session_workspaces'),
      s = setup(t)
    const pages =
      kind === 'sql'
        ? new SidebarSessions(t, s.workspaces)
        : new MemorySidebarSessions(s.workspaces, s.ownership, s.preferences, async () => ({
            items: s.registry.rows().map((row) => ({ ...row, sessionCount: 0, available: true })),
          }))
    const groupId = workspaceIdFor('/repo')
    try {
      s.add('parent')
      s.ownership.inherit('parent', 'kid', 'owner', 2)
      s.workspaces.put('kid', '/repo')
      s.workspaces.observe('kid', event(1, 'session/start', '2026-10-15T00:00:00Z', { preset: 'standard' }))
      s.workspaces.observe('kid', event(2, 'user/message', '2026-10-16T01:00:00Z'))
      s.ownership.activateFork('parent', 'kid', 'owner', 2)
      s.add('theirs', '/repo', 'other')
      const rows = (await pages.list('owner', { groupId })).items
      expect(rows.map((row) => [row.sessionId, row.parent, row.forkAt])).toEqual([
        ['kid', 'parent', 2],
        ['parent', undefined, undefined],
      ])
      expect(rows[1]).not.toHaveProperty('parent')
      expect(rows[1]).not.toHaveProperty('forkAt')
      expect((await pages.list('other', { groupId })).items.map((row) => row.sessionId)).toEqual(['theirs'])
    } finally {
      await pages.close()
      await tables.close()
    }
  },
)

it.each(['sql', 'memory'])(
  'moves pinned sessions into a first pinned group ordered by pin time, apart from their workspace (%s)',
  async (kind) => {
    let now = 0
    const tables = sqliteTables(),
      t = tables.table('session_workspaces'),
      s = setup(t, () => ++now)
    const pages =
      kind === 'sql'
        ? new SidebarSessions(t, s.workspaces)
        : new MemorySidebarSessions(s.workspaces, s.ownership, s.preferences, async () => ({
            items: s.registry.rows().map((row) => ({ ...row, sessionCount: 0, available: true })),
          }))
    const groupId = workspaceIdFor('/repo')
    const group = async (id: string) => (await pages.groups('owner')).items.find((g) => g.groupId === id)!
    const ids = (page: { items: { sessionId: string }[] }) => page.items.map((row) => row.sessionId)
    try {
      for (let i = 0; i < 7; i++) s.add(`s${i}`, '/repo', 'owner', `2026-10-1${i}T00:00:00Z`)
      s.add('u0', '/other')
      s.add('foreign', '/repo', 'other')
      const before = await pages.groups('owner')
      expect(before.items[0]).toMatchObject({ groupId: 'pinned', total: 0, lastMessageAt: null })
      expect(before.items[0]).not.toHaveProperty('workspaceId')
      for (const key of ['s0', 's1', 's2', 's3', 's4', 's5', 'u0', 'foreign']) s.preferences.pin(key, true)
      const after = await pages.groups('owner')
      expect(after.items.map((g) => [g.groupId, g.total])).toEqual([
        ['pinned', 7],
        [groupId, 1],
        ['unassigned', 0],
      ])
      for (const id of ['pinned', groupId])
        expect(after.items.find((g) => g.groupId === id)?.revision).not.toBe(
          before.items.find((g) => g.groupId === id)?.revision,
        )
      const first = await pages.list('owner', { groupId: 'pinned' })
      expect(ids(first)).toEqual(['u0', 's5', 's4', 's3', 's2'])
      expect(first.items[0]?.pinnedAt).toBe(new Date(7).toISOString())
      expect(ids(await pages.list('owner', { groupId }))).toEqual(['s6'])
      // Pinning again keeps the original time and leaves an open page valid.
      expect(s.preferences.pin('s0', true).pinnedAt).toBe(new Date(1).toISOString())
      expect(ids(await pages.list('owner', { groupId: 'pinned', cursor: first.next! }))).toEqual(['s1', 's0'])
      s.preferences.pin('s5', false)
      await expect(pages.list('owner', { groupId: 'pinned', cursor: first.next! })).rejects.toMatchObject({
        data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' },
      })
      expect(ids(await pages.list('owner', { groupId }))).toEqual(['s6', 's5'])
      // Archiving unpins; an archived session cannot be pinned until it is restored.
      const pinned = (await group('pinned')).revision
      expect(s.preferences.archive('s4', true)).toEqual({ archived: true })
      expect((await group('pinned')).revision).not.toBe(pinned)
      expect(() => s.preferences.pin('s4', true)).toThrow(
        expect.objectContaining({ data: expect.objectContaining({ code: 'SESSION_ARCHIVED' }) }),
      )
      s.preferences.archive('s4', false)
      expect(ids(await pages.list('owner', { groupId }))).toEqual(['s6', 's5', 's4'])
      expect(await group('pinned')).toMatchObject({ total: 5 })
    } finally {
      await pages.close()
      await tables.close()
    }
  },
)

it('uses owner SQL capabilities and atomically invalidates pages for an independent database writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-sidebar-'))
  const open = () => createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
  const reader = open(),
    writer = open()
  let pages: SidebarSessions | undefined
  try {
    const t = adapt(reader.tables('@agnes/daemon').table('session_workspaces')),
      s = setup(t)
    pages = new SidebarSessions(t, s.workspaces)
    for (let i = 0; i < 6; i++) s.add(`s${i}`)
    const groupId = workspaceIdFor('/repo'),
      first = await pages.list('owner', { groupId })
    const other = setup(adapt(writer.tables('@agnes/daemon').table('session_workspaces')))
    other.add('imported', '/repo', 'owner', '2026-10-17T00:00:00Z')
    await expect(pages.list('owner', { groupId, cursor: first.next! })).rejects.toMatchObject({
      data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' },
    })
    expect((await pages.list('owner', { groupId })).items[0]?.sessionId).toBe('imported')
    const unassigned = (await pages.groups('owner')).items.find((g) => g.groupId === 'unassigned')!
    other.add('registered-later', '/later')
    expect((await pages.groups('owner')).items.find((g) => g.groupId === 'unassigned')?.revision).not.toBe(
      unassigned.revision,
    )
    other.registry.put({ path: '/later', name: 'later' }, '2026-10-15T00:00:00Z')
    expect(
      (await pages.list('owner', { groupId: workspaceIdFor('/later') })).items.map((x) => x.sessionId),
    ).toEqual(['registered-later'])
  } finally {
    await pages?.close()
    await writer.close()
    await reader.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('backfills in bounded batches, refuses partial groups, resumes failures and preserves newer live messages', async () => {
  const tables = sqliteTables(),
    t = tables.table('session_workspaces'),
    s = setup(t)
  s.add('legacy')
  t.exec(
    'UPDATE session_workspaces SET last_seq = 1002, message_seq = 0, message_at = NULL WHERE session_key = ?',
    ['legacy'],
  )
  const ledger = [
    event(1, 'session/start', '2026-10-15T00:00:00Z', { preset: 'standard' }),
    ...Array.from({ length: 1001 }, (_, i) => event(i + 2)),
  ]
  let fail = true
  const scan = vi.fn(
    async (_key: string, query: { fromSeq?: number; toSeq?: number; limit: number; order?: string }) => {
      if (query.order === 'desc') return ledger.slice(-1)
      if (query.fromSeq === 501 && fail) throw new Error('read failed')
      return ledger
        .filter((e) => e.seq >= (query.fromSeq ?? 1) && e.seq <= (query.toSeq ?? Infinity))
        .slice(0, query.limit)
    },
  )
  const pages = new SidebarSessions(t, s.workspaces, scan),
    groupId = workspaceIdFor('/repo')
  try {
    expect((await pages.groups('owner')).ready).toBe(false)
    await expect(pages.list('owner', { groupId })).rejects.toMatchObject({
      data: { code: 'SESSION_SIDEBAR_NOT_READY' },
    })
    await vi.waitFor(() =>
      expect(
        t.get<{ sidebar_failed: number }>('SELECT sidebar_failed FROM session_workspaces')?.sidebar_failed,
      ).toBe(1),
    )
    expect(t.get<{ message_seq: number }>('SELECT message_seq FROM session_workspaces')?.message_seq).toBe(
      500,
    )
    fail = false
    s.workspaces.observe('legacy', event(1003, 'assistant/message', '2026-10-18T00:00:00Z'))
    ledger.push(event(1003, 'assistant/message', '2026-10-18T00:00:00Z'))
    await pages.groups('owner')
    await vi.waitFor(async () => expect((await pages.groups('owner')).ready).toBe(true))
    expect((await pages.list('owner', { groupId })).items[0]?.lastMessageAt).toBe('2026-10-18T00:00:00.000Z')
    expect(scan.mock.calls.every(([, q]) => q.limit <= 500)).toBe(true)
  } finally {
    await pages.close()
    await tables.close()
  }
})
