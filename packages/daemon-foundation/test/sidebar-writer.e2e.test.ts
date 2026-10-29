import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { SessionWorkspaceIndex } from '../src/storage/lister.js'
import { SessionPrincipalOwnershipIndex } from '../src/storage/session-ownership.js'
import { SessionPreferencesStore } from '../src/storage/session-preferences.js'
import { SidebarSessions } from '../src/storage/sidebar-sessions.js'
import { WorkspaceIndex, workspaceIdFor } from '../src/storage/workspaces.js'
import { sqliteTables } from './sqlite-tables.js'

it('expires a live cursor when another process activates an imported session in the same database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agh-sidebar-writer-'))
  const tables = sqliteTables(join(root, 'index.db')),
    t = tables.table('session_workspaces')
  const sessions = new SessionWorkspaceIndex(t),
    owners = new SessionPrincipalOwnershipIndex(t)
  new SessionPreferencesStore(t)
  new WorkspaceIndex(t).put({ path: '/synthetic', name: 'synthetic' }, '2026-01-01T00:00:00Z')
  const pages = new SidebarSessions(t, sessions),
    groupId = workspaceIdFor('/synthetic')
  try {
    for (let i = 0; i < 6; i++) {
      owners.bindNew(`s${i}`, 'owner')
      sessions.put(`s${i}`, '/synthetic')
      t.exec(
        "UPDATE session_workspaces SET created_at = '2026-01-01T00:00:00Z', sidebar_sort_at = 1 WHERE session_key = ?",
        [`s${i}`],
      )
      owners.activateNew(`s${i}`, 'owner')
    }
    const first = await pages.list('owner', { groupId })
    const pinned = await pages.list('owner', { groupId: 'pinned' })
    expect(pinned.items).toEqual([])
    const script = `
      import { SessionWorkspaceIndex } from './packages/daemon-foundation/src/storage/lister.ts';
      import { SessionPrincipalOwnershipIndex } from './packages/daemon-foundation/src/storage/session-ownership.ts';
      import { SessionPreferencesStore } from './packages/daemon-foundation/src/storage/session-preferences.ts';
      import { sqliteTables } from './packages/daemon-foundation/test/sqlite-tables.ts';
      const tables = sqliteTables(process.argv[1]), t = tables.table('session_workspaces');
      const sessions = new SessionWorkspaceIndex(t), owners = new SessionPrincipalOwnershipIndex(t);
      try {
        owners.bindNew('imported', 'owner'); sessions.put('imported', '/synthetic');
        sessions.observe('imported', { seq: 1, type: 'session/start', lane: 'main', ts: '2026-10-16T00:00:00Z', data: {} });
        owners.activateNew('imported', 'owner');
        new SessionPreferencesStore(t).pin('s1', true);
      } finally { await tables.close(); }
    `
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, join(root, 'index.db')],
      { cwd: resolve('.'), timeout: 30_000 },
    )
    await expect(pages.list('owner', { groupId, cursor: first.next! })).rejects.toMatchObject({
      data: { code: 'SESSION_SIDEBAR_CURSOR_STALE' },
    })
    expect((await pages.list('owner', { groupId })).items[0]?.sessionId).toBe('imported')
    // The other process pinned s1: it moved out of its workspace into the pinned group.
    expect((await pages.list('owner', { groupId: 'pinned' })).revision).not.toBe(pinned.revision)
    expect((await pages.list('owner', { groupId: 'pinned' })).items.map((row) => row.sessionId)).toEqual([
      's1',
    ])
    expect((await pages.groups('owner')).items.find((group) => group.groupId === groupId)?.total).toBe(6)
  } finally {
    await pages.close()
    await tables.close()
    if (resolve(root).startsWith(`${resolve(tmpdir())}${sep}agh-sidebar-writer-`))
      rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
