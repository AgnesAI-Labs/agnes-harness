import type { DatabaseSync } from 'node:sqlite'
import type { ComparisonTreeCut, RuntimeIdentity } from '@agnes/protocol'

/** One Core SQLite read transaction captures authoritative delegated membership and physical
 * own-prefix boundaries. History forks outside child_tasks are not owned descendants. */
export function comparisonTreeSnapshot(db: DatabaseSync, rootSessionKey: string): ComparisonTreeCut {
  const rows = db
    .prepare(`WITH RECURSIVE owned(key) AS (
    SELECT ? UNION SELECT child_key FROM child_tasks JOIN owned ON parent_key=owned.key LIMIT 513
  ) SELECT owned.key,child_tasks.parent_key AS owner_parent,sessions.parent_key AS history_parent,
    sessions.boundary_seq,(SELECT MAX(seq) FROM events WHERE session_key=owned.key) AS head
    FROM owned LEFT JOIN child_tasks ON child_tasks.child_key=owned.key
    LEFT JOIN sessions ON sessions.session_key=owned.key ORDER BY owned.key LIMIT 513`)
    .all(rootSessionKey)
  const issues = new Set<string>()
  if (rows.length > 512) issues.add('tree_member_limit')
  const members: ComparisonTreeCut['members'] = []
  for (const row of rows.slice(0, 512)) {
    const sessionId = String(row.key)
    const inheritedThroughSeq = row.history_parent == null ? 0 : Number(row.boundary_seq)
    const throughSeq = Number(row.head ?? inheritedThroughSeq)
    if (
      !Number.isSafeInteger(inheritedThroughSeq) ||
      inheritedThroughSeq < 0 ||
      !Number.isSafeInteger(throughSeq) ||
      throughSeq <= inheritedThroughSeq
    ) {
      issues.add('tree_member_unstarted')
      continue
    }
    const first = db
      .prepare('SELECT type,origin,trust,data FROM events WHERE session_key=? AND seq=?')
      .get(sessionId, inheritedThroughSeq + 1)
    let data:
      | { key?: unknown; runtime?: RuntimeIdentity; parent?: { key?: unknown; boundarySeq?: unknown } }
      | undefined
    try {
      data = first ? JSON.parse(String(first.data)) : undefined
    } catch {
      /* Unknown is explicit below. */
    }
    const runtime = data?.runtime ?? { id: 'native', version: '1' }
    if (
      first?.type !== 'session/start' ||
      first.origin !== 'system' ||
      first.trust !== 'trusted' ||
      data?.key !== sessionId ||
      !['native', 'jevloop'].includes(runtime.id) ||
      runtime.version !== '1' ||
      (inheritedThroughSeq > 0 &&
        (data.parent?.key !== row.history_parent || data.parent?.boundarySeq !== inheritedThroughSeq))
    ) {
      issues.add('tree_member_identity_unknown')
      continue
    }
    members.push({
      sessionId,
      parentSessionId: sessionId === rootSessionKey ? null : String(row.owner_parent),
      runtime,
      inheritedThroughSeq,
      throughSeq,
    })
  }
  return { members, complete: issues.size === 0, issues: [...issues] }
}
