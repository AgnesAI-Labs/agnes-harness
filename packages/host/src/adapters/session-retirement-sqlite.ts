import type { DatabaseSync } from 'node:sqlite'
import { type CommitTx, CoreError } from '@agnes/core'
import type { RetirementIntegrityReader } from './session-budget-origin-backfill.js'
import type { SessionOwnerEvidence } from './session-owner-evidence.js'
import {
  type ClosedSessionTree,
  confirmClosedSessionTree,
  type SessionTreeRetirementIdentity,
} from './session-retirement-proof.js'
import { type PurgeSealedSessionTree, sqliteSessionTreePurge } from './session-retirement-purge.js'

export interface SessionTreeMember {
  sessionKey: string
  parentKey: string | null
  kind: 'root' | 'delegated'
  state?: string
  creationPhase?: string
}
export interface SessionTreeInspection {
  rootSessionKey: string
  members: SessionTreeMember[]
  sealed?: { retirementId: string; epoch: number }
  /** Published only by the atomic joint idle seal, not by a general admission fence. */
  idleSealed?: true
  /** Neither a live writer claim nor its absence proves execution quiescence. */
  /** Missing evidence stays unknown, including allocated but never opened members. */
  ownerEvidence: Array<{ sessionKey: string; evidence?: SessionOwnerEvidence }>
  writerClaims: Array<{ sessionKey: string; writerRunId: string; generation: number; until: number }>
  openTurns: Array<{ sessionKey: string; lane: string; startSeq: number }>
  /** Independent history forks are retention dependencies, never owned descendants to delete. */
  externalHistoryDependents: Array<{ sessionKey: string; parentKey: string; boundarySeq: number }>
}
export interface SessionRetirementStore {
  /** Exact latest-owner/member/head aggregation; never closes or reopens a runtime. */
  confirmSealedSessionTreeClosed(input: SessionTreeRetirementIdentity): Promise<ClosedSessionTree>
  /** Requires prior archive publication and exact-owner closure; never removes workspace files. */
  purgeSealedSessionTree(input: PurgeSealedSessionTree): Promise<void>
  /** Validates the same destructive preconditions without deleting rows; may persist verified legacy origins. */
  checkSealedSessionTreePurge(
    input: PurgeSealedSessionTree,
    options?: { beforeWorkspaceCleanup?: boolean },
  ): Promise<void>
  /** Atomically prove idle membership for all trees before publishing any permanent fence. */
  sealIdleSessionTrees(
    inputs: readonly (SessionTreeRetirementIdentity & {
      /** Production idle acquisition snapshot, checked under the same write lock as sealing. */
      expectedOwners?: readonly SessionOwnerEvidence[]
    })[],
  ): Promise<SessionTreeInspection[]>
  inspectSessionTree(rootSessionKey: string): Promise<SessionTreeInspection>
  /** Admission fence only. The caller must separately prove idle state and close every exact owner. */
  sealSessionTree(input: {
    rootSessionKey: string
    retirementId: string
    epoch: number
  }): Promise<SessionTreeInspection>
  assertSessionAdmittedTree(sessionKey: string): void
}

/** All admission checks run on the same connection/transaction as the write they protect. */
export function sqliteSessionRetirement(
  db: DatabaseSync,
  tx: <T>(fn: () => T) => T,
  head: (key: string) => number,
  scanIntegrity: RetirementIntegrityReader,
  readOwnerEvidence: (sessionKey: string) => SessionOwnerEvidence | undefined,
  readComparisonAdmission: (
    keys: readonly string[],
    remembered: ReadonlySet<string>,
    authorityKnown: boolean,
  ) => string[],
) {
  const tree = db.prepare(`WITH RECURSIVE tree(session_key) AS (
    SELECT ? UNION SELECT child_key FROM child_tasks JOIN tree ON child_tasks.parent_key=tree.session_key
  ) SELECT session_key FROM tree ORDER BY session_key`)
  const sealed = db.prepare('SELECT retirement_id,epoch FROM session_retirements WHERE root_session_key=?')
  const member = db.prepare('SELECT root_session_key FROM session_retirement_members WHERE session_key=?')
  const persisted = db.prepare(
    'SELECT session_key,parent_key,kind FROM session_retirement_members WHERE root_session_key=? ORDER BY session_key',
  )
  function assertAdmitted(sessionKey: string): void {
    if (member.get(sessionKey))
      throw new CoreError('E_CLOSED', 'Session tree admission is permanently sealed')
    const ancestors = new Set<string>()
    let cursor: string | undefined = sessionKey
    while (cursor !== undefined) {
      if (ancestors.has(cursor)) throw new CoreError('E_RELATION', 'Delegated ownership contains a cycle')
      ancestors.add(cursor)
      const row: { parent_key: string } | undefined = db
        .prepare('SELECT parent_key FROM child_tasks WHERE child_key=?')
        .get(cursor) as { parent_key: string } | undefined
      cursor = row ? String(row.parent_key) : undefined
    }
    const remembered = new Set(
      [...ancestors].filter((key) =>
        db.prepare('SELECT 1 FROM session_comparison_roots WHERE session_key=?').get(key),
      ),
    )
    for (const key of readComparisonAdmission(
      [...ancestors],
      remembered,
      !!db.prepare('SELECT 1 FROM session_comparison_roots LIMIT 1').get(),
    ))
      db.prepare('INSERT OR IGNORE INTO session_comparison_roots(session_key) VALUES(?)').run(key)
  }
  /** Classification is derived from exact durable reservations, not a caller label or key
   * spelling. History forks inherit the security floor even though they are not owned members
   * of a retirement tree. Missing known authority remains fail-closed in the shared reader. */
  function comparisonSandboxRequired(sessionKey: string): boolean {
    const ancestors = new Set<string>()
    let cursor: string | undefined = sessionKey
    while (cursor !== undefined) {
      if (ancestors.has(cursor)) throw new CoreError('E_RELATION', 'Session ancestry contains a cycle')
      ancestors.add(cursor)
      const child: { parent_key: string } | undefined = db
        .prepare('SELECT parent_key FROM child_tasks WHERE child_key=?')
        .get(cursor) as { parent_key: string } | undefined
      const history: { parent_key: string | null } | undefined = db
        .prepare('SELECT parent_key FROM sessions WHERE session_key=?')
        .get(cursor) as { parent_key: string | null } | undefined
      const parent: string | null | undefined = child?.parent_key ?? history?.parent_key
      cursor = parent === null || parent === undefined ? undefined : String(parent)
    }
    const remembered = new Set(
      [...ancestors].filter((key) =>
        db.prepare('SELECT 1 FROM session_comparison_roots WHERE session_key=?').get(key),
      ),
    )
    const roots = readComparisonAdmission(
      [...ancestors],
      remembered,
      !!db.prepare('SELECT 1 FROM session_comparison_roots LIMIT 1').get(),
    )
    for (const key of roots)
      db.prepare('INSERT OR IGNORE INTO session_comparison_roots(session_key) VALUES(?)').run(key)
    return roots.length > 0
  }
  function inspect(rootSessionKey: string): SessionTreeInspection {
    const receipt = sealed.get(rootSessionKey) as { retirement_id: string; epoch: number } | undefined
    const rows = receipt ? persisted.all(rootSessionKey) : tree.all(rootSessionKey)
    const members: SessionTreeMember[] = rows.map((row) => {
      const sessionKey = String(row.session_key)
      const child = db
        .prepare('SELECT parent_key,state,creation_phase FROM child_tasks WHERE child_key=?')
        .get(sessionKey) as { parent_key: string; state: string; creation_phase: string } | undefined
      return {
        sessionKey,
        parentKey: receipt
          ? row.parent_key === null
            ? null
            : String(row.parent_key)
          : sessionKey === rootSessionKey
            ? null
            : (child?.parent_key ?? null),
        kind: sessionKey === rootSessionKey ? 'root' : 'delegated',
        ...(child ? { state: child.state, creationPhase: child.creation_phase } : {}),
      }
    })
    const keys = new Set(members.map((row) => row.sessionKey))
    const writerClaims: SessionTreeInspection['writerClaims'] = []
    const openTurns: SessionTreeInspection['openTurns'] = []
    const externalHistoryDependents: SessionTreeInspection['externalHistoryDependents'] = []
    for (const { sessionKey } of members) {
      const claim = db
        .prepare('SELECT run_id,generation,until FROM writer_claims WHERE session_key=?')
        .get(sessionKey)
      if (claim)
        writerClaims.push({
          sessionKey,
          writerRunId: String(claim.run_id),
          generation: Number(claim.generation),
          until: Number(claim.until),
        })
      for (const row of db
        .prepare(`SELECT e.lane,e.seq FROM events e WHERE e.session_key=? AND e.type='turn/start'
        AND NOT EXISTS (SELECT 1 FROM events later WHERE later.session_key=e.session_key AND later.lane=e.lane AND later.seq>e.seq AND later.type IN ('turn/start','turn/end'))`)
        .all(sessionKey))
        openTurns.push({
          sessionKey,
          lane: Buffer.from(row.lane as Uint8Array).toString('utf8'),
          startSeq: Number(row.seq),
        })
      for (const row of db
        .prepare('SELECT session_key,boundary_seq FROM sessions WHERE parent_key=?')
        .all(sessionKey))
        if (!keys.has(String(row.session_key)))
          externalHistoryDependents.push({
            sessionKey: String(row.session_key),
            parentKey: sessionKey,
            boundarySeq: Number(row.boundary_seq),
          })
    }
    return {
      rootSessionKey,
      members,
      ownerEvidence: members.map(({ sessionKey }) => {
        const evidence = readOwnerEvidence(sessionKey)
        return { sessionKey, ...(evidence ? { evidence } : {}) }
      }),
      writerClaims,
      openTurns,
      externalHistoryDependents,
      ...(receipt ? { sealed: { retirementId: receipt.retirement_id, epoch: receipt.epoch } } : {}),
      ...(db.prepare('SELECT 1 FROM session_retirement_idle WHERE root_session_key=?').get(rootSessionKey)
        ? { idleSealed: true as const }
        : {}),
    }
  }
  function seal(input: SessionTreeRetirementIdentity): SessionTreeInspection {
    if (!input.rootSessionKey || !input.retirementId || !Number.isSafeInteger(input.epoch) || input.epoch < 0)
      throw new CoreError('E_ENVELOPE', 'Invalid session retirement identity')
    const previous = sealed.get(input.rootSessionKey) as { retirement_id: string; epoch: number } | undefined
    if (previous) {
      if (previous.retirement_id !== input.retirementId || previous.epoch !== input.epoch)
        throw new CoreError('E_RELATION', 'Session retirement identity conflicts')
      return inspect(input.rootSessionKey)
    }
    const current = inspect(input.rootSessionKey)
    for (const row of current.members)
      if (member.get(row.sessionKey))
        throw new CoreError('E_CLOSED', 'Session already belongs to another retirement')
    db.prepare('INSERT INTO session_retirements(root_session_key,retirement_id,epoch) VALUES(?,?,?)').run(
      input.rootSessionKey,
      input.retirementId,
      input.epoch,
    )
    const insert = db.prepare(
      'INSERT INTO session_retirement_members(session_key,root_session_key,parent_key,kind) VALUES(?,?,?,?)',
    )
    for (const row of current.members) {
      insert.run(row.sessionKey, input.rootSessionKey, row.parentKey, row.kind)
      // Preserve legacy opaque budget-root associations before any later child-row purge.
      db.prepare(`INSERT OR IGNORE INTO session_budget_origins(root_task_id,session_key)
              SELECT root_task_id,child_key FROM child_tasks WHERE child_key=?`).run(row.sessionKey)
    }
    return inspect(input.rootSessionKey)
  }
  function assertIdle(current: SessionTreeInspection): void {
    if (
      current.sealed &&
      db.prepare('SELECT 1 FROM session_tree_purges WHERE root_session_key=?').get(current.rootSessionKey)
    ) {
      confirmClosedSessionTree(
        db,
        { rootSessionKey: current.rootSessionKey, ...current.sealed },
        current,
        head,
      )
      return
    }
    if (
      current.ownerEvidence.some((row) => !row.evidence) ||
      current.openTurns.length ||
      current.externalHistoryDependents.length ||
      current.members.some(
        (row) =>
          row.kind === 'delegated' &&
          (!['completed', 'failed', 'cancelled', 'interrupted'].includes(row.state ?? '') ||
            !['committed', 'cancelled'].includes(row.creationPhase ?? '')),
      )
    )
      throw new CoreError('E_RELATION', 'Cannot seal an active, dependent, or unknown session tree')
    for (const member of current.members)
      for (const row of db
        .prepare(
          "SELECT register,data FROM registers WHERE session_key=? AND register IN ('op.state','inbox')",
        )
        .all(member.sessionKey)) {
        if (row.register === 'op.state' && row.data !== 'null')
          throw new CoreError('E_RELATION', 'Cannot seal active program state')
        if (row.register === 'inbox') {
          const data = JSON.parse(String(row.data)) as { items?: unknown } | null
          if (!Array.isArray(data?.items) || data.items.length)
            throw new CoreError('E_RELATION', 'Cannot seal pending input')
        }
      }
  }
  return {
    comparisonSandboxRequired,
    async confirmSealedSessionTreeClosed(input: SessionTreeRetirementIdentity): Promise<ClosedSessionTree> {
      return tx(() => confirmClosedSessionTree(db, input, inspect(input.rootSessionKey), head))
    },
    purgeSealedSessionTree: sqliteSessionTreePurge(db, tx, inspect, head, scanIntegrity),
    checkSealedSessionTreePurge(
      input: PurgeSealedSessionTree,
      options?: { beforeWorkspaceCleanup?: boolean },
    ) {
      return sqliteSessionTreePurge(
        db,
        tx,
        inspect,
        head,
        scanIntegrity,
        options?.beforeWorkspaceCleanup ? 'before-workspace-cleanup' : 'check',
      )(input)
    },
    assertSessionAdmittedTree: assertAdmitted,
    assertIdleCommit(sessionKey: string, commit: CommitTx): void {
      if (
        !db
          .prepare(`SELECT 1 FROM session_retirement_members m JOIN session_retirement_idle i
        ON i.root_session_key=m.root_session_key WHERE m.session_key=?`)
          .get(sessionKey)
      )
        return
      if (commit.opState && commit.opState.data !== null)
        throw new CoreError('E_CLOSED', 'Idle retirement forbids new program state')
      for (const event of commit.events) {
        if (event.register === 'op.state' && event.data !== null)
          throw new CoreError('E_CLOSED', 'Idle retirement forbids new program state')
        if (event.register === 'inbox') {
          const data = event.data as { items?: unknown } | null
          if (!Array.isArray(data?.items) || data.items.length)
            throw new CoreError('E_CLOSED', 'Idle retirement forbids new pending input')
        }
      }
    },
    inspectSessionTree: async (rootSessionKey: string) => tx(() => inspect(rootSessionKey)),
    async sealSessionTree(input: SessionTreeRetirementIdentity): Promise<SessionTreeInspection> {
      db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON')
      try {
        return tx(() => seal(input))
      } finally {
        db.exec('PRAGMA synchronous=NORMAL')
      }
    },
    async sealIdleSessionTrees(
      inputs: readonly (SessionTreeRetirementIdentity & {
        expectedOwners?: readonly SessionOwnerEvidence[]
      })[],
    ): Promise<SessionTreeInspection[]> {
      if (!inputs.length || new Set(inputs.map((input) => input.rootSessionKey)).size !== inputs.length)
        throw new CoreError('E_ENVELOPE', 'Invalid tree retirement batch')
      db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON')
      try {
        return tx(() => {
          const keys = new Set<string>()
          for (const input of inputs) {
            const current = inspect(input.rootSessionKey)
            if (input.expectedOwners) {
              const expected = new Map(input.expectedOwners.map((value) => [value.owner.sessionKey, value]))
              if (expected.size !== input.expectedOwners.length || expected.size !== current.members.length)
                throw new CoreError('E_RELATION', 'Retirement idle membership changed')
              for (const row of current.ownerEvidence) {
                const before = expected.get(row.sessionKey)
                const after = row.evidence
                if (
                  !before ||
                  !after ||
                  before.owner.writerRunId !== after.owner.writerRunId ||
                  before.owner.ownerEpoch !== after.owner.ownerEpoch ||
                  before.closed?.finalSeq !== after.closed?.finalSeq ||
                  !!before.closed !== !!after.closed
                )
                  throw new CoreError('E_RELATION', 'Retirement idle owner changed')
              }
            }
            assertIdle(current)
            for (const member of current.members) {
              if (keys.has(member.sessionKey)) throw new CoreError('E_RELATION', 'Retirement trees overlap')
              keys.add(member.sessionKey)
            }
          }
          const sealedTrees = inputs.map(seal)
          for (const input of inputs)
            db.prepare('INSERT OR IGNORE INTO session_retirement_idle(root_session_key) VALUES(?)').run(
              input.rootSessionKey,
            )
          return sealedTrees
        })
      } finally {
        db.exec('PRAGMA synchronous=NORMAL')
      }
    },
    assertReservationAdmitted(rootTaskId: string, originSessionKey?: string): void {
      // Explicit origin is mandatory for new production callers; old records retain structural
      // child/root associations without attempting to parse an opaque rootTaskId.
      if (originSessionKey !== undefined) assertAdmitted(originSessionKey)
      for (const row of db
        .prepare(`SELECT session_key FROM session_budget_origins WHERE root_task_id=?
        UNION SELECT child_key AS session_key FROM child_tasks WHERE root_task_id=?
        UNION SELECT parent_key AS session_key FROM child_tasks WHERE root_task_id=?`)
        .all(rootTaskId, rootTaskId, rootTaskId))
        assertAdmitted(String(row.session_key))
    },
    recordReservationOrigin(rootTaskId: string, originSessionKey?: string): void {
      if (originSessionKey !== undefined)
        db.prepare('INSERT OR IGNORE INTO session_budget_origins(root_task_id,session_key) VALUES(?,?)').run(
          rootTaskId,
          originSessionKey,
        )
    },
  }
}
