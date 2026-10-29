import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type ChildCandidate = {
  childKey: string
  parentKey: string
  state: string
  isolation: string
  path: string | null
  phase: string | null
  keepReason?: string
}

export type RepairResult = {
  childKey: string
  action: 'processed' | 'skipped' | 'blocked'
  reason: string
}

const KEEP_PHASES = new Set(['kept_dirty', 'kept_unmerged', 'inspection_failed', 'cleanup_failed'])

export function sessionsDbPath(dataDir: string): string {
  return join(dataDir, 'sessions.db')
}

export function listChildCandidates(dbPath: string): ChildCandidate[] {
  if (!existsSync(dbPath)) return []
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='child_tasks'")
      .get() as { name: string } | undefined
    if (!tables) return []
    const rows = db
      .prepare(
        `SELECT t.child_key, t.parent_key, t.state, t.isolation, w.path, w.phase
         FROM child_tasks t LEFT JOIN child_workspaces w ON w.child_key = t.child_key`,
      )
      .all() as Array<{
      child_key: string
      parent_key: string
      state: string
      isolation: string
      path: string | null
      phase: string | null
    }>
    return rows.map((row) => {
      const keep = KEEP_PHASES.has(row.phase ?? '')
      return {
        childKey: row.child_key,
        parentKey: row.parent_key,
        state: row.state,
        isolation: row.isolation,
        path: row.path,
        phase: row.phase,
        ...(keep && row.phase ? { keepReason: row.phase } : {}),
      }
    })
  } finally {
    db.close()
  }
}

export function repairChildCandidates(_dbPath: string, _limit = 50, _now = Date.now()): RepairResult[] {
  return [
    {
      childKey: '_v1',
      action: 'skipped',
      reason: 'automatic repair is disabled in this release',
    },
  ]
}

export function maintenanceTick(dbPath: string): RepairResult[] {
  return repairChildCandidates(dbPath, 50)
}
