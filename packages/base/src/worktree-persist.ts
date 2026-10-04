import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { GitWorktreeDeps, WorktreeEntry } from '../extensions/subagent/src/worktree.js'

const darwin = process.platform === 'darwin' // guards-allow-platform: F_FULLFSYNC is darwin-only.

/** Persist exact Git cleanup evidence; absence from a manager's Map is never deletion proof. */
export function sqliteWorktreePersist(dataDir: string): NonNullable<GitWorktreeDeps['persist']> {
  const file = join(dataDir, 'sessions.db')
  function access<T>(write: boolean, fn: (db: DatabaseSync) => T): T | undefined {
    if (!existsSync(file)) {
      if (write) throw new Error('Worktree persistence is unavailable')
      return undefined
    }
    const db = new DatabaseSync(file)
    try {
      db.exec('PRAGMA busy_timeout=5000')
      if (write) {
        db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON')
        if (darwin) db.exec('PRAGMA checkpoint_fullfsync=ON')
        db.exec('BEGIN IMMEDIATE')
      }
      const result = fn(db)
      if (write) db.exec('COMMIT')
      return result
    } catch (error) {
      if (write && db.isTransaction) db.exec('ROLLBACK')
      throw error
    } finally {
      db.close()
    }
  }
  function advance(db: DatabaseSync, entry: WorktreeEntry, from: string, to: string): void {
    if (!entry.childKey && !entry.workspaceId) return // An unbound creation rollback owns no row.
    if (!entry.childKey || !entry.workspaceId) throw new Error('Worktree ownership is incomplete')
    const identity = [entry.childKey, entry.workspaceId, entry.path, entry.root, entry.branch]
    const row = db
      .prepare(`SELECT phase FROM child_workspaces WHERE child_key=? AND workspace_id=?
      AND path=? AND root=? AND branch=? AND isolation='worktree'`)
      .get(...identity)
    if (
      !row ||
      (row.phase !== from &&
        row.phase !== to &&
        !(to === 'worktree_removed' && row.phase === 'branch_removed'))
    )
      throw new Error('Worktree cleanup ownership or phase changed')
    if (row.phase !== from) return
    if (
      db
        .prepare(`UPDATE child_workspaces SET phase=? WHERE child_key=? AND workspace_id=?
      AND path=? AND root=? AND branch=? AND isolation='worktree' AND phase=?`)
        .run(to, ...identity, from).changes !== 1
    )
      throw new Error('Worktree cleanup receipt was not persisted')
  }
  return {
    load() {
      return (
        access(false, (db) => {
          const entries = new Map<string, WorktreeEntry>()
          for (const row of db
            .prepare(`SELECT child_key,workspace_id,path,root,branch,phase FROM child_workspaces
          WHERE isolation='worktree' AND phase IN ('attached','worktree_removed')`)
            .all()) {
            if (!row.path || !row.root || !row.branch) continue
            if (
              typeof row.child_key !== 'string' ||
              !row.child_key ||
              typeof row.workspace_id !== 'string' ||
              !row.workspace_id
            )
              throw new Error('Persisted worktree ownership is incomplete')
            const path = String(row.path)
            if (entries.has(path)) throw new Error('Worktree path has multiple owners')
            entries.set(path, {
              childKey: String(row.child_key),
              workspaceId: String(row.workspace_id),
              path,
              root: String(row.root),
              branch: String(row.branch),
              stage: row.phase === 'worktree_removed' ? 'worktree-removed' : 'attached',
            })
          }
          return entries
        }) ?? new Map()
      )
    },
    save(entries) {
      // Stale managers may still contain attached entries; they cannot regress a later phase.
      const removed = [...entries.values()].filter(
        (entry) => entry.stage === 'worktree-removed' && entry.childKey,
      )
      if (!removed.length) return
      access(true, (db) => {
        for (const entry of removed) advance(db, entry, 'attached', 'worktree_removed')
      })
    },
    removed(entry) {
      if (!entry.childKey && !entry.workspaceId) return
      access(true, (db) => {
        advance(db, entry, 'worktree_removed', 'branch_removed')
      })
    },
    bind(childKey, entry) {
      if (entry.childKey !== undefined && entry.childKey !== childKey)
        throw new Error('Worktree belongs to another child')
      access(true, (db) => {
        const owner = db.prepare('SELECT workspace_id FROM child_workspaces WHERE child_key=?').get(childKey)
        if (!owner || (entry.workspaceId && entry.workspaceId !== owner.workspace_id))
          throw new Error('Worktree owner is missing or changed')
        const changed = db
          .prepare(`UPDATE child_workspaces SET path=?,phase='attached',root=?,branch=?
          WHERE child_key=? AND isolation='worktree' AND
          ((phase IN ('planned','preparing') AND root IS NULL AND branch IS NULL)
          OR (phase='attached' AND path=? AND root=? AND branch=?))`)
          .run(entry.path, entry.root, entry.branch, childKey, entry.path, entry.root, entry.branch)
        if (changed.changes !== 1) throw new Error('Worktree binding is missing, conflicting, or retired')
        if (
          db.prepare('UPDATE child_tasks SET cwd=? WHERE child_key=?').run(entry.path, childKey).changes !== 1
        )
          throw new Error('Worktree child is missing')
        entry.childKey = childKey
        entry.workspaceId = String(owner.workspace_id)
      })
    },
  }
}
