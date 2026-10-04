import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { CoreError, canonicalJson } from '@agnes/core'
import {
  backfillVerifiedBudgetOrigins,
  type RetirementIntegrityReader,
} from './session-budget-origin-backfill.js'
import { confirmClosedSessionTree } from './session-retirement-proof.js'
import type { SessionTreeInspection } from './session-retirement-sqlite.js'

export interface PurgeSealedSessionTree {
  /** Opt-in execution-only purge; independently verified completed calls keep unknown accounting unchanged. */
  accounting?: 'retain-verified-ended'
  rootSessionKey: string
  retirementId: string
  epoch: number
  members: readonly { sessionKey: string; finalSeq: number }[]
}

const refuse = (reason: string): never => {
  throw new CoreError('E_RELATION', `Session tree purge refused: ${reason}`)
}
const micro = (value: unknown): boolean => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
const strings = (value: unknown): string[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(value))
  } catch {
    return refuse('invalid bookkeeping JSON')
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string' || !v))
    return refuse('invalid scope identities')
  return parsed
}

/** Private storage cleanup only. The caller must first publish the complete archive and prove
 * every exact runtime owner closed. This operation cannot prove either cross-store fact, and
 * never removes workspace files. Permanent admission and purge receipts survive all deletion. */
export function sqliteSessionTreePurge(
  db: DatabaseSync,
  tx: <T>(fn: () => T) => T,
  inspect: (root: string) => SessionTreeInspection,
  head: (key: string) => number,
  scanIntegrity: RetirementIntegrityReader,
  mode: 'purge' | 'check' | 'before-workspace-cleanup' = 'purge',
) {
  const budgetSnapshot = (root: string) => {
    const reservations = db
      .prepare('SELECT * FROM budget_reservations WHERE root_task_id=? ORDER BY permit_id')
      .all(root)
    const ids = new Set(reservations.map((row) => String(row.permit_id)))
    return {
      scopes: db.prepare('SELECT * FROM budget_scopes WHERE root_task_id=? ORDER BY scope_id').all(root),
      reservations,
      costs: db
        .prepare('SELECT * FROM cost_origins ORDER BY origin_key')
        .all()
        .filter((row) =>
          ids.has(String((JSON.parse(String(row.scope_ids)) as { permitId?: unknown }).permitId)),
        ),
      generations: db
        .prepare('SELECT * FROM child_writer_gens WHERE root_task_id=? ORDER BY root_task_id')
        .all(root),
    }
  }
  const budgetDigest = (root: string) =>
    createHash('sha256')
      .update(canonicalJson(budgetSnapshot(root)))
      .digest('hex')
  return async (input: PurgeSealedSessionTree): Promise<void> => {
    if (!input.rootSessionKey || !input.retirementId || !Number.isSafeInteger(input.epoch) || input.epoch < 0)
      refuse('invalid retirement identity')
    const members = input.members
      .map(({ sessionKey, finalSeq }) => ({ sessionKey, finalSeq }))
      .sort((a, b) => (a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0))
    const keys = new Set(members.map((row) => row.sessionKey))
    if (
      !keys.has(input.rootSessionKey) ||
      keys.size !== members.length ||
      members.some((row) => !row.sessionKey || !Number.isSafeInteger(row.finalSeq) || row.finalSeq < 0)
    )
      refuse('invalid final heads')
    const evidence = JSON.stringify(members)
    db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON')
    try {
      tx(() => {
        const current = inspect(input.rootSessionKey)
        if (current.sealed?.retirementId !== input.retirementId || current.sealed.epoch !== input.epoch)
          refuse('retirement identity mismatch')
        if (current.members.length !== keys.size || current.members.some((row) => !keys.has(row.sessionKey)))
          refuse('membership mismatch')
        for (const row of db
          .prepare(
            'SELECT session_key,parent_key,kind FROM session_retirement_members WHERE root_session_key=?',
          )
          .all(input.rootSessionKey)) {
          if (
            row.session_key === input.rootSessionKey
              ? row.kind !== 'root' || row.parent_key !== null
              : row.kind !== 'delegated' || !keys.has(String(row.parent_key))
          )
            refuse('invalid permanent lineage')
        }
        const retainedReceipt = db
          .prepare('SELECT * FROM session_tree_retained_budgets WHERE root_session_key=?')
          .all(input.rootSessionKey)
        if (retainedReceipt.length && input.accounting !== 'retain-verified-ended')
          refuse('retained accounting requires its explicit purge mode')
        if (input.accounting !== undefined && input.accounting !== 'retain-verified-ended')
          refuse('unknown accounting mode')
        if (input.accounting === 'retain-verified-ended') {
          const proof = confirmClosedSessionTree(db, input, current, head)
          for (const row of retainedReceipt) {
            const receipt = JSON.parse(String(row.evidence)) as {
              version?: unknown
              mode?: unknown
              budgetDigest?: unknown
              owners?: unknown
              settlements?: unknown
            }
            if (
              row.retirement_id !== input.retirementId ||
              row.epoch !== input.epoch ||
              receipt.version !== 1 ||
              receipt.mode !== 'retain-verified-ended' ||
              receipt.budgetDigest !== budgetDigest(String(row.root_task_id)) ||
              canonicalJson(receipt.owners) !== canonicalJson(proof.members) ||
              !Array.isArray(receipt.settlements) ||
              !receipt.settlements.length
            )
              refuse('retained accounting receipt conflicts')
          }
        }
        const previous = db
          .prepare('SELECT retirement_id,epoch,final_heads FROM session_tree_purges WHERE root_session_key=?')
          .get(input.rootSessionKey)
        if (previous) {
          if (
            previous.retirement_id !== input.retirementId ||
            previous.epoch !== input.epoch ||
            previous.final_heads !== evidence
          )
            refuse('purge receipt mismatch')
          return
        }
        if (
          current.writerClaims.length ||
          current.openTurns.length ||
          current.externalHistoryDependents.length
        )
          refuse('writers, open turns, or external history dependents remain')
        const version = db.prepare('SELECT version FROM child_control_meta WHERE id=1').get()
        if (version?.version !== 5) refuse('unknown child bookkeeping format')
        const children = db.prepare('SELECT * FROM child_tasks').all()
        const roots = new Set<string>()
        for (const row of children) {
          const owned = keys.has(String(row.child_key))
          if (keys.has(String(row.parent_key)) && !owned) refuse('unsealed delegated child')
          if (!owned) continue
          if (
            !keys.has(String(row.parent_key)) ||
            row.control_format !== 5 ||
            !['completed', 'failed', 'cancelled', 'interrupted'].includes(String(row.state)) ||
            !['committed', 'cancelled'].includes(String(row.creation_phase))
          )
            refuse('child is active, unresolved, or has an unknown format')
          const member = current.members.find((entry) => entry.sessionKey === row.child_key)
          if (member?.parentKey !== row.parent_key) refuse('delegated lineage mismatch')
          roots.add(String(row.root_task_id))
        }
        for (const member of current.members)
          if (member.kind === 'delegated' && !children.some((row) => row.child_key === member.sessionKey))
            refuse('delegated bookkeeping is missing')
        for (const row of members) {
          const session = db
            .prepare('SELECT format_version FROM sessions WHERE session_key=?')
            .get(row.sessionKey)
          if (session?.format_version !== 1 || head(row.sessionKey) !== row.finalSeq)
            refuse('session format or final head mismatch')
          if (
            db
              .prepare("SELECT 1 FROM registers WHERE session_key=? AND register='op.state' AND data!='null'")
              .get(row.sessionKey)
          )
            refuse('active or unknown op state')
        }
        backfillVerifiedBudgetOrigins(db, head, scanIntegrity)
        const origins = db.prepare('SELECT * FROM session_budget_origins').all()
        for (const row of db.prepare('SELECT root_task_id FROM child_writer_gens').all())
          if (
            !origins.some((origin) => origin.root_task_id === row.root_task_id) &&
            !children.some((child) => child.root_task_id === row.root_task_id)
          )
            refuse('writer generation ownership has no durable origin')
        for (const row of origins) if (keys.has(String(row.session_key))) roots.add(String(row.root_task_id))
        for (const root of roots) {
          const bound = origins.filter((row) => row.root_task_id === root)
          if (
            !bound.length ||
            bound.some((row) => !keys.has(String(row.session_key))) ||
            children.some((row) => row.root_task_id === root && !keys.has(String(row.child_key)))
          )
            refuse('budget root ownership is shared or unknown')
        }
        const retainedRoots = new Set<string>()
        if (input.accounting === 'retain-verified-ended')
          for (const row of db
            .prepare("SELECT root_task_id FROM budget_reservations WHERE status='unknown'")
            .all())
            if (roots.has(String(row.root_task_id))) retainedRoots.add(String(row.root_task_id))
        const verifiedSettlements = retainedRoots.size
          ? backfillVerifiedBudgetOrigins(db, head, scanIntegrity, {
              verifyRoots: retainedRoots,
              requireResponse: true,
            })
          : []
        const scopes = db.prepare('SELECT * FROM budget_scopes').all()
        for (const row of scopes)
          if (
            !origins.some((origin) => origin.root_task_id === row.root_task_id) &&
            !children.some((child) => child.root_task_id === row.root_task_id)
          )
            refuse('scope ownership has no durable origin')
        const scopeIds = new Set(
          scopes.filter((row) => roots.has(String(row.root_task_id))).map((row) => String(row.scope_id)),
        )
        for (const row of scopes) {
          if (
            row.child_key !== null &&
            keys.has(String(row.child_key)) &&
            !scopeIds.has(String(row.scope_id))
          )
            refuse('unbound child scope')
          if (scopeIds.has(String(row.scope_id))) {
            if (
              !micro(row.settled_micro) ||
              (row.cap_micro !== null && !micro(row.cap_micro)) ||
              (row.child_key !== null && !keys.has(String(row.child_key))) ||
              !micro(row.held_micro) ||
              (row.held_micro !== '0' && !retainedRoots.has(String(row.root_task_id))) ||
              (row.parent_scope_id !== null && !scopeIds.has(String(row.parent_scope_id)))
            )
              refuse('scope is held or shared')
          } else if (row.parent_scope_id !== null && scopeIds.has(String(row.parent_scope_id)))
            refuse('external scope dependent')
        }
        for (const row of children) {
          const references = [String(row.budget_scope_id), ...strings(row.ancestor_scope_ids)]
          if (keys.has(String(row.child_key)) && references.some((id) => !scopeIds.has(id)))
            refuse('owned child scope is missing or foreign')
          if (!keys.has(String(row.child_key)) && references.some((id) => scopeIds.has(id)))
            refuse('foreign child uses scope')
        }
        const reservations = db.prepare('SELECT * FROM budget_reservations').all()
        const permits = new Set<string>()
        for (const row of reservations) {
          const ids = strings(row.scope_ids)
          const owned = roots.has(String(row.root_task_id))
          if (owned) {
            if (
              (row.q_micro !== null && !micro(row.q_micro)) ||
              !Number.isSafeInteger(row.writer_generation) ||
              Number(row.writer_generation) < 1 ||
              !ids.length ||
              ids.some((id) => !scopeIds.has(id)) ||
              ![
                'settled',
                'released',
                ...(retainedRoots.has(String(row.root_task_id)) ? ['unknown'] : []),
              ].includes(String(row.status))
            )
              refuse('reservation is unresolved or crosses ownership')
            permits.add(String(row.permit_id))
          } else if (ids.some((id) => scopeIds.has(id))) refuse('foreign reservation uses scope')
        }
        const costs: string[] = []
        for (const row of db.prepare('SELECT * FROM cost_origins').all()) {
          let envelope: Record<string, unknown>
          try {
            envelope = JSON.parse(String(row.scope_ids))
          } catch {
            return refuse('unknown cost origin format')
          }
          if (envelope?.v !== 2 || !Array.isArray(envelope.scopeIds)) refuse('unknown cost origin format')
          const costScopes = envelope.scopeIds as unknown[]
          const originKey = String(row.origin_key)
          const split = originKey.lastIndexOf(':')
          const originOwned = keys.has(originKey.slice(0, split))
          const owned = permits.has(String(envelope.permitId))
          if (originOwned || owned || costScopes.some((id) => scopeIds.has(String(id)))) {
            const reservation = reservations.find((r) => r.permit_id === envelope.permitId)
            if (
              (!micro(row.micro) &&
                !(
                  reservation &&
                  retainedRoots.has(String(reservation.root_task_id)) &&
                  row.micro === 'unknown'
                )) ||
              !owned ||
              !originOwned ||
              !/^[1-9][0-9]*$/.test(originKey.slice(split + 1)) ||
              !reservation ||
              envelope.effectId !== reservation.effect_id ||
              envelope.requestHash !== reservation.request_hash ||
              envelope.writerGeneration !== reservation.writer_generation ||
              JSON.stringify(envelope.scopeIds) !== reservation.scope_ids
            )
              refuse('cost origin ownership or binding mismatch')
            costs.push(originKey)
          }
        }
        for (const row of db.prepare('SELECT * FROM child_workspaces').all()) {
          if (!keys.has(String(row.child_key))) continue
          if (
            ![
              'planned',
              'preparing',
              'attached',
              'cleanup_eligible',
              'inspecting',
              'worktree_removed',
              'branch_removed',
              'kept_dirty',
              'kept_unmerged',
              'inspection_failed',
              'cleanup_failed',
            ].includes(String(row.phase))
          )
            refuse('unknown workspace format')
          if (
            row.isolation !== 'shared' &&
            !(
              row.isolation === 'worktree' &&
              (row.phase === 'branch_removed' ||
                (mode === 'before-workspace-cleanup' &&
                  ['attached', 'worktree_removed', 'cleanup_eligible'].includes(String(row.phase)) &&
                  typeof row.root === 'string' &&
                  typeof row.branch === 'string'))
            )
          )
            refuse('workspace cleanup has not been proven')
          if (
            children.some(
              (child) => child.workspace_id === row.workspace_id && !keys.has(String(child.child_key)),
            )
          )
            refuse('workspace bookkeeping is shared')
        }
        if (mode !== 'purge') return
        for (const root of retainedRoots) {
          const proof = confirmClosedSessionTree(db, input, current, head)
          const evidence = canonicalJson({
            version: 1,
            mode: 'retain-verified-ended',
            budgetDigest: budgetDigest(root),
            settlements: verifiedSettlements.filter((row) => row.root === root),
            owners: proof.members,
          })
          db.prepare(
            'INSERT INTO session_tree_retained_budgets(root_session_key,retirement_id,epoch,root_task_id,evidence) VALUES(?,?,?,?,?)',
          ).run(input.rootSessionKey, input.retirementId, input.epoch, root, evidence)
        }
        for (const cost of costs) {
          const row = db.prepare('SELECT scope_ids FROM cost_origins WHERE origin_key=?').get(cost)
          const permitId = (JSON.parse(String(row?.scope_ids)) as { permitId: string }).permitId
          if (
            !retainedRoots.has(String(reservations.find((row) => row.permit_id === permitId)?.root_task_id))
          )
            db.prepare('DELETE FROM cost_origins WHERE origin_key=?').run(cost)
        }
        for (const root of roots)
          if (!retainedRoots.has(root))
            for (const table of ['budget_reservations', 'budget_scopes', 'child_writer_gens'])
              db.prepare(`DELETE FROM ${table} WHERE root_task_id=?`).run(root)
        for (const { sessionKey } of members) {
          db.prepare('DELETE FROM child_workspaces WHERE child_key=?').run(sessionKey)
          db.prepare('DELETE FROM child_ordinals WHERE parent_key=?').run(sessionKey)
          db.prepare('DELETE FROM child_tasks WHERE child_key=?').run(sessionKey)
          for (const table of ['events', 'registers', 'sessions'])
            db.prepare(`DELETE FROM ${table} WHERE session_key=?`).run(sessionKey)
        }
        db.prepare(
          'INSERT INTO session_tree_purges(root_session_key,retirement_id,epoch,final_heads) VALUES(?,?,?,?)',
        ).run(input.rootSessionKey, input.retirementId, input.epoch, evidence)
      })
    } finally {
      db.exec('PRAGMA synchronous=NORMAL')
    }
  }
}
