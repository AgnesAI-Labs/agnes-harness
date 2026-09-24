import {
  type BeginChildAttemptInput,
  type CancelCreatingChildInput,
  type CancelledChildFact,
  type ChildControlStore,
  type ChildCreationCasInput,
  type ChildTaskRecord,
  CoreError,
  type CreateDelegatedChildInput,
  type CreateDelegatedChildResult,
  canTransitionChildState,
  type DeferCreatingChildInput,
  type DeferredChildFact,
  type PlannedWorkspace,
  type ReserveRequest,
  type ReserveResult,
  type SettleRequest,
  type TreeUsage,
} from '@agnes/core'

const CHILD_CONTROL_FORMAT = 4
const ACTIVE = new Set(['creating', 'ready', 'running', 'waiting_approval', 'recovery_pending', 'cancelling'])
type ReservationRecord = {
  permitId: string
  rootTaskId: string
  scopeIds: string[]
  qMicro: bigint
  effectId: string
  requestHash: string
  writerGeneration: number
  status: 'held' | 'settled' | 'released' | 'unknown'
}

type OriginEnvelope = {
  v: 2
  permitId: string
  effectId: string
  requestHash: string
  writerGeneration: number
  scopeIds: string[]
}

function originEnvelope(reservation: ReservationRecord): OriginEnvelope {
  return {
    v: 2,
    permitId: reservation.permitId,
    effectId: reservation.effectId,
    requestHash: reservation.requestHash,
    writerGeneration: reservation.writerGeneration,
    scopeIds: [...reservation.scopeIds],
  }
}

function sameOriginEnvelope(value: unknown, expected: OriginEnvelope): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).sort()
  if (keys.join(',') !== 'effectId,permitId,requestHash,scopeIds,v,writerGeneration') return false
  return (
    row.v === 2 &&
    row.permitId === expected.permitId &&
    row.effectId === expected.effectId &&
    row.requestHash === expected.requestHash &&
    row.writerGeneration === expected.writerGeneration &&
    Array.isArray(row.scopeIds) &&
    row.scopeIds.length === expected.scopeIds.length &&
    row.scopeIds.every((scope, index) => scope === expected.scopeIds[index])
  )
}

function isActive(state: string): boolean {
  return ACTIVE.has(state)
}

function addMicro(a: bigint, b: bigint): bigint {
  const sum = a + b
  if (a > 0n && b > 0n && sum < a) throw new CoreError('E_BUDGET', 'microcredit addition overflow')
  return sum
}

function fitsCap(settled: bigint, held: bigint, q: bigint, cap: bigint): boolean {
  return q >= 0n && settled + held + q <= cap
}

import type { DatabaseSync } from 'node:sqlite'

type Db = Pick<DatabaseSync, 'prepare' | 'exec'>

type WorkspaceRow = {
  workspace_id: string
  child_key: string
  isolation: PlannedWorkspace['isolation']
  path: string
  phase: PlannedWorkspace['phase']
}

function parseWorkspace(row: WorkspaceRow | undefined): PlannedWorkspace | null {
  if (!row) return null
  return {
    workspaceId: row.workspace_id,
    childKey: row.child_key,
    isolation: row.isolation,
    path: row.path,
    phase: row.phase,
  }
}

const TASK_SELECT =
  'SELECT t.*, s.boundary_seq AS boundary_seq FROM child_tasks t LEFT JOIN sessions s ON s.session_key = t.child_key'

function parseTask(row: Record<string, unknown>): ChildTaskRecord {
  const deferredFact = row.deferred_fact
    ? (JSON.parse(String(row.deferred_fact)) as DeferredChildFact)
    : undefined
  const cancelledFact = row.cancelled_fact
    ? (JSON.parse(String(row.cancelled_fact)) as CancelledChildFact)
    : undefined
  return {
    childKey: String(row.child_key),
    creationId: String(row.creation_id),
    attemptId: String(row.attempt_id),
    creationPhase: row.creation_phase as ChildTaskRecord['creationPhase'],
    creationRevision: Number(row.creation_revision),
    attemptStartedAt: Number(row.attempt_started_at),
    ...(deferredFact ? { deferredFact } : {}),
    ...(cancelledFact ? { cancelledFact } : {}),
    parentKey: String(row.parent_key),
    rootTaskId: String(row.root_task_id),
    runtimeOwnerSessionKey: String(row.runtime_owner),
    kind: row.kind as ChildTaskRecord['kind'],
    generationDepth: Number(row.generation_depth),
    generationLimit: Number(row.generation_limit),
    boundarySeq: Number(row.boundary_seq ?? 0),
    inputHash: String(row.input_hash),
    inputText: String(row.input_text ?? ''),
    cwd: String(row.cwd),
    actorId: String(row.actor_id),
    budgetScopeId: String(row.budget_scope_id),
    ancestorScopeIds: JSON.parse(String(row.ancestor_scope_ids)) as string[],
    workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    isolation: row.isolation as ChildTaskRecord['isolation'],
    state: row.state as ChildTaskRecord['state'],
    stateRevision: Number(row.state_revision),
    controlFormat: Number(row.control_format),
  }
}

function creationCasError(input: ChildCreationCasInput): CoreError {
  return new CoreError('E_CAS', 'child creation attempt changed', {
    childKey: input.childKey,
    creationId: input.creationId,
    attemptId: input.attemptId,
    expectedRevision: input.expectedRevision,
  })
}

export function sqliteChildControl(
  db: Db,
  tx: <T>(fn: () => T) => T,
  clock: () => number = Date.now,
): ChildControlStore {
  // Keep the v3 reservation migration while advancing the store to v4 creation attempts. Older
  // databases could contain duplicate reservation identities because reserve always allocated.
  // Preserve those rows and their accounting, but quarantine every duplicate after the first; a
  // held duplicate becomes unknown so recovery cannot mistake an orphaned hold for replayable work.
  tx(() => {
    const version = db.prepare('SELECT version FROM child_control_meta WHERE id = 1').get() as
      | { version: number }
      | undefined
    if (version && version.version > CHILD_CONTROL_FORMAT)
      throw new CoreError(
        'E_FORMAT',
        `child control format ${version.version} is newer than runtime ${CHILD_CONTROL_FORMAT}`,
      )
    db.exec(`WITH ranked AS (
      SELECT rowid, ROW_NUMBER() OVER (PARTITION BY root_task_id, effect_id ORDER BY rowid) AS ordinal
      FROM budget_reservations
    )
    UPDATE budget_reservations
    SET effect_id = '__agnes_legacy_duplicate__:' || permit_id || ':' || rowid,
        status = CASE WHEN status = 'held' THEN 'unknown' ELSE status END
    WHERE rowid IN (SELECT rowid FROM ranked WHERE ordinal > 1)`)
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS budget_reservations_root_effect ON budget_reservations (root_task_id, effect_id)',
    )
    db.prepare(
      'INSERT INTO child_control_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version',
    ).run(CHILD_CONTROL_FORMAT)
  })
  const q = {
    meta: db.prepare('SELECT version FROM child_control_meta WHERE id = 1'),
    upsertMeta: db.prepare(
      'INSERT INTO child_control_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version',
    ),
    task: db.prepare(`${TASK_SELECT} WHERE t.child_key = ?`),
    byCreation: db.prepare(`${TASK_SELECT} WHERE t.creation_id = ?`),
    byParent: db.prepare(`${TASK_SELECT} WHERE t.parent_key = ?`),
    byRoot: db.prepare(`${TASK_SELECT} WHERE t.root_task_id = ?`),
    creating: db.prepare(`${TASK_SELECT} WHERE t.creation_phase = 'creating'`),
    insertTask: db.prepare(
      `INSERT INTO child_tasks (child_key, creation_id, parent_key, root_task_id, runtime_owner, kind,
        generation_depth, generation_limit, input_hash, input_text, cwd, actor_id, budget_scope_id, ancestor_scope_ids,
        workspace_id, isolation, state, state_revision, control_format, attempt_id, creation_phase,
        creation_revision, attempt_started_at, deferred_fact, cancelled_fact)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    beginAttempt: db.prepare(
      `UPDATE child_tasks
       SET attempt_id = ?, creation_phase = 'creating', creation_revision = creation_revision + 1,
           attempt_started_at = ?, deferred_fact = NULL, cancelled_fact = NULL
       WHERE child_key = ? AND creation_id = ? AND attempt_id = ? AND creation_phase = 'deferred'
         AND creation_revision = ?`,
    ),
    deferAttempt: db.prepare(
      `UPDATE child_tasks
       SET creation_phase = 'deferred', creation_revision = creation_revision + 1, deferred_fact = ?
       WHERE child_key = ? AND creation_id = ? AND attempt_id = ? AND creation_phase = 'creating'
         AND creation_revision = ?`,
    ),
    commitAttempt: db.prepare(
      `UPDATE child_tasks
       SET creation_phase = 'committed', creation_revision = creation_revision + 1
       WHERE child_key = ? AND creation_id = ? AND attempt_id = ? AND creation_phase = 'creating'
         AND creation_revision = ?`,
    ),
    cancelAttempt: db.prepare(
      `UPDATE child_tasks
       SET creation_phase = 'cancelled', creation_revision = creation_revision + 1, cancelled_fact = ?
       WHERE child_key = ? AND creation_id = ? AND attempt_id = ? AND creation_phase = 'creating'
         AND creation_revision = ?`,
    ),
    cas: db.prepare(
      'UPDATE child_tasks SET state = ?, state_revision = state_revision + 1 WHERE child_key = ? AND state_revision = ?',
    ),
    session: db.prepare('SELECT session_key FROM sessions WHERE session_key = ?'),
    insertChildSession: db.prepare(
      'INSERT INTO sessions (session_key, format_version, parent_key, boundary_seq, created_at) VALUES (?, 1, ?, ?, ?)',
    ),
    scope: db.prepare('SELECT * FROM budget_scopes WHERE scope_id = ?'),
    insertScope: db.prepare(
      'INSERT INTO budget_scopes (scope_id, root_task_id, child_key, parent_scope_id, cap_micro, settled_micro, held_micro) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    updateScope: db.prepare('UPDATE budget_scopes SET settled_micro = ?, held_micro = ? WHERE scope_id = ?'),
    insertRes: db.prepare(
      'INSERT INTO budget_reservations (permit_id, root_task_id, scope_ids, q_micro, effect_id, request_hash, writer_generation, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    res: db.prepare('SELECT * FROM budget_reservations WHERE permit_id = ?'),
    resByEffect: db.prepare('SELECT * FROM budget_reservations WHERE root_task_id = ? AND effect_id = ?'),
    resByIdentity: db.prepare(
      'SELECT * FROM budget_reservations WHERE root_task_id = ? AND effect_id = ? AND request_hash = ?',
    ),
    updateRes: db.prepare('UPDATE budget_reservations SET status = ? WHERE permit_id = ?'),
    heldResByRoot: db.prepare("SELECT * FROM budget_reservations WHERE root_task_id = ? AND status = 'held'"),
    updateHeldGeneration: db.prepare(
      "UPDATE budget_reservations SET writer_generation = ? WHERE root_task_id = ? AND status = 'held' AND writer_generation = ?",
    ),
    origin: db.prepare('SELECT * FROM cost_origins WHERE origin_key = ?'),
    insertOrigin: db.prepare('INSERT INTO cost_origins (origin_key, micro, scope_ids) VALUES (?, ?, ?)'),
    workspace: db.prepare('SELECT * FROM child_workspaces WHERE workspace_id = ?'),
    insertWs: db.prepare(
      'INSERT INTO child_workspaces (workspace_id, child_key, isolation, path, phase) VALUES (?, ?, ?, ?, ?)',
    ),
    ordinal: db.prepare('SELECT n FROM child_ordinals WHERE parent_key = ? AND effect_id = ?'),
    upsertOrdinal: db.prepare(
      'INSERT INTO child_ordinals (parent_key, effect_id, n) VALUES (?, ?, 1) ON CONFLICT(parent_key, effect_id) DO UPDATE SET n = n + 1',
    ),
    resByRoot: db.prepare('SELECT status FROM budget_reservations WHERE root_task_id = ?'),
    writerGen: db.prepare('SELECT generation FROM child_writer_gens WHERE root_task_id = ?'),
    bumpWriter: db.prepare(
      `INSERT INTO child_writer_gens (root_task_id, generation) VALUES (?, 2)
       ON CONFLICT(root_task_id) DO UPDATE SET generation = generation + 1`,
    ),
    updateWs: db.prepare(
      'UPDATE child_workspaces SET phase = ?, path = ?, root = ?, branch = ? WHERE workspace_id = ?',
    ),
    updateTaskCwd: db.prepare('UPDATE child_tasks SET cwd = ? WHERE child_key = ?'),
    wsByPath: db.prepare('SELECT * FROM child_workspaces WHERE path = ?'),
    wsByChild: db.prepare('SELECT * FROM child_workspaces WHERE child_key = ?'),
    maxPermit: db.prepare(
      `SELECT permit_id FROM budget_reservations WHERE permit_id LIKE 'p%' ORDER BY length(permit_id) DESC, permit_id DESC LIMIT 1`,
    ),
  }
  const format = (): number => {
    const row = q.meta.get() as { version: number } | undefined
    return row?.version ?? 1
  }
  const assertWritable = (): void => {
    const v = format()
    if (v > CHILD_CONTROL_FORMAT)
      throw new CoreError(
        'E_FORMAT',
        `child control format ${v} is newer than runtime ${CHILD_CONTROL_FORMAT}`,
      )
  }
  const mark = (): void => {
    q.upsertMeta.run(CHILD_CONTROL_FORMAT)
  }
  const scopeOf = (id: string) => {
    const row = q.scope.get(id) as
      | {
          scope_id: string
          root_task_id: string
          child_key: string | null
          parent_scope_id: string | null
          cap_micro: string
          settled_micro: string
          held_micro: string
        }
      | undefined
    if (!row) return null
    return {
      scopeId: row.scope_id,
      rootTaskId: row.root_task_id,
      childKey: row.child_key,
      parentScopeId: row.parent_scope_id,
      capMicro: BigInt(row.cap_micro),
      settledMicro: BigInt(row.settled_micro),
      heldMicro: BigInt(row.held_micro),
    }
  }
  const reservationOf = (row: Record<string, unknown> | undefined): ReservationRecord | null => {
    if (!row) return null
    return {
      permitId: String(row.permit_id),
      rootTaskId: String(row.root_task_id),
      scopeIds: JSON.parse(String(row.scope_ids)) as string[],
      qMicro: BigInt(String(row.q_micro)),
      effectId: String(row.effect_id),
      requestHash: String(row.request_hash),
      writerGeneration: Number(row.writer_generation),
      status: row.status as ReservationRecord['status'],
    }
  }

  const store: ChildControlStore = {
    childControlFormat: () => format(),
    assertWritableFormat: () => assertWritable(),
    async existsSession(key) {
      return Boolean(q.session.get(key))
    },
    async lookupByKey(childKey) {
      const row = q.task.get(childKey) as Record<string, unknown> | undefined
      return row ? parseTask(row) : null
    },
    async lookupByCreationId(creationId) {
      const row = q.byCreation.get(creationId) as Record<string, unknown> | undefined
      return row ? parseTask(row) : null
    },
    async listByParent(parentKey) {
      return (q.byParent.all(parentKey) as Array<Record<string, unknown>>).map(parseTask)
    },
    async listByRoot(rootTaskId) {
      return (q.byRoot.all(rootTaskId) as Array<Record<string, unknown>>).map(parseTask)
    },
    async listCreatingChildAttempts() {
      return (q.creating.all() as Array<Record<string, unknown>>).map(parseTask)
    },
    async beginChildAttempt(input: BeginChildAttemptInput) {
      return tx(() => {
        const prior = q.task.get(input.childKey) as Record<string, unknown> | undefined
        if (!prior || String(prior.creation_id) !== input.creationId) return null
        if (
          String(prior.creation_phase) === 'creating' &&
          String(prior.attempt_id) === input.nextAttemptId &&
          Number(prior.creation_revision) === input.expectedRevision + 1
        )
          return parseTask(prior)
        if (!input.nextAttemptId || input.nextAttemptId === input.previousAttemptId) return null
        const changed = q.beginAttempt.run(
          input.nextAttemptId,
          input.startedAt,
          input.childKey,
          input.creationId,
          input.previousAttemptId,
          input.expectedRevision,
        )
        if (changed.changes !== 1) return null
        return parseTask(q.task.get(input.childKey) as Record<string, unknown>)
      })
    },
    async deferCreatingChild(input: DeferCreatingChildInput) {
      return tx(() => {
        const prior = q.task.get(input.childKey) as Record<string, unknown> | undefined
        if (
          prior &&
          String(prior.creation_phase) === 'deferred' &&
          String(prior.creation_id) === input.creationId &&
          String(prior.attempt_id) === input.attemptId &&
          prior.deferred_fact
        )
          return JSON.parse(String(prior.deferred_fact)) as DeferredChildFact
        const fact: DeferredChildFact = Object.freeze({
          childKey: input.childKey,
          creationId: input.creationId,
          attemptId: input.attemptId,
          revision: input.expectedRevision + 1,
          deferredAt: input.deferredAt,
        })
        const changed = q.deferAttempt.run(
          JSON.stringify(fact),
          input.childKey,
          input.creationId,
          input.attemptId,
          input.expectedRevision,
        )
        if (changed.changes !== 1) throw creationCasError(input)
        return fact
      })
    },
    async commitCreatingChild(input: ChildCreationCasInput) {
      return tx(() => {
        const prior = q.task.get(input.childKey) as Record<string, unknown> | undefined
        if (
          prior &&
          String(prior.creation_phase) === 'committed' &&
          String(prior.creation_id) === input.creationId &&
          String(prior.attempt_id) === input.attemptId
        )
          return true
        return (
          q.commitAttempt.run(input.childKey, input.creationId, input.attemptId, input.expectedRevision)
            .changes === 1
        )
      })
    },
    async cancelCreatingChild(input: CancelCreatingChildInput) {
      return tx(() => {
        const prior = q.task.get(input.childKey) as Record<string, unknown> | undefined
        if (
          prior &&
          String(prior.creation_phase) === 'cancelled' &&
          String(prior.creation_id) === input.creationId &&
          String(prior.attempt_id) === input.attemptId &&
          prior.cancelled_fact
        )
          return JSON.parse(String(prior.cancelled_fact)) as CancelledChildFact
        const fact: CancelledChildFact = Object.freeze({
          childKey: input.childKey,
          creationId: input.creationId,
          attemptId: input.attemptId,
          revision: input.expectedRevision + 1,
          reason: input.reason,
          cancelledAt: input.cancelledAt,
        })
        const changed = q.cancelAttempt.run(
          JSON.stringify(fact),
          input.childKey,
          input.creationId,
          input.attemptId,
          input.expectedRevision,
        )
        if (changed.changes !== 1) throw creationCasError(input)
        return fact
      })
    },
    async casState(childKey, expectedRevision, next) {
      return tx(() => {
        const row = q.task.get(childKey) as Record<string, unknown> | undefined
        if (!row || Number(row.state_revision) !== expectedRevision) return false
        if (!canTransitionChildState(String(row.state) as ChildTaskRecord['state'], next)) return false
        return q.cas.run(next, childKey, expectedRevision).changes === 1
      })
    },
    async nextOrdinal(parentKey, effectId) {
      return tx(() => {
        q.upsertOrdinal.run(parentKey, effectId)
        return (q.ordinal.get(parentKey, effectId) as { n: number }).n
      })
    },
    async workspace(workspaceId) {
      return parseWorkspace(q.workspace.get(workspaceId) as WorkspaceRow | undefined)
    },
    async ensureRootScope(rootTaskId, capMicro) {
      return tx(() => {
        assertWritable()
        const existing = scopeOf(`root:${rootTaskId}`)
        if (existing) return existing
        q.insertScope.run(`root:${rootTaskId}`, rootTaskId, null, null, capMicro.toString(), '0', '0')
        mark()
        const created = scopeOf(`root:${rootTaskId}`)
        if (!created) throw new CoreError('E_STORAGE_FAULT', 'failed to persist root budget scope')
        return created
      })
    },
    async scopeForChild(childKey) {
      const task = await store.lookupByKey(childKey)
      return task ? scopeOf(task.budgetScopeId) : null
    },
    async createDelegatedChild(input: CreateDelegatedChildInput): Promise<CreateDelegatedChildResult> {
      return tx(() => {
        assertWritable()
        const existingRow = q.byCreation.get(input.creationId) as Record<string, unknown> | undefined
        if (existingRow) {
          const record = parseTask(existingRow)
          return { status: record.inputHash === input.inputHash ? 'existing' : 'conflict', record }
        }
        const parentActive = (q.byParent.all(input.parentKey) as Array<Record<string, unknown>>)
          .map(parseTask)
          .filter((row) => isActive(row.state)).length
        const rootActive = (q.byRoot.all(input.rootTaskId) as Array<Record<string, unknown>>)
          .map(parseTask)
          .filter((row) => isActive(row.state)).length
        if (parentActive >= input.maxFanOut || rootActive >= input.maxFanOut)
          return {
            status: 'refused',
            reason: 'fan_out',
            message: `fan-out limit ${input.maxFanOut} reached`,
          }
        const root = scopeOf(`root:${input.rootTaskId}`)
        if (!root) return { status: 'refused', reason: 'budget', message: 'tree budget scope is missing' }
        const parentRow = q.task.get(input.parentKey) as Record<string, unknown> | undefined
        const parentTask = parentRow ? parseTask(parentRow) : null
        const ancestorScopeIds = parentTask ? [...parentTask.ancestorScopeIds] : [root.scopeId]
        if (parentTask && !ancestorScopeIds.includes(parentTask.budgetScopeId))
          ancestorScopeIds.push(parentTask.budgetScopeId)
        if (!ancestorScopeIds.includes(root.scopeId)) ancestorScopeIds.unshift(root.scopeId)
        for (const id of ancestorScopeIds) {
          const scope = scopeOf(id)
          if (!scope) return { status: 'refused', reason: 'budget', message: `unknown ancestor scope ${id}` }
          if (
            input.childCapMicro !== null &&
            input.childCapMicro > scope.capMicro - scope.settledMicro - scope.heldMicro
          )
            return {
              status: 'refused',
              reason: 'budget',
              message: 'child budget exceeds remaining ancestor cap',
            }
        }
        if (!q.session.get(input.parentKey))
          throw new CoreError('E_STORAGE_FAULT', 'parent session missing', { parent: input.parentKey })
        if (q.session.get(input.childKey))
          throw new CoreError('E_STORAGE_FAULT', 'child key exists', { childKey: input.childKey })
        q.insertChildSession.run(input.childKey, input.parentKey, input.boundarySeq, new Date().toISOString())
        let budgetScopeId = parentTask?.budgetScopeId ?? root.scopeId
        if (input.childCapMicro !== null) {
          budgetScopeId = `child:${input.childKey}`
          q.insertScope.run(
            budgetScopeId,
            input.rootTaskId,
            input.childKey,
            parentTask?.budgetScopeId ?? root.scopeId,
            input.childCapMicro.toString(),
            '0',
            '0',
          )
          ancestorScopeIds.push(budgetScopeId)
        }
        q.insertTask.run(
          input.childKey,
          input.creationId,
          input.parentKey,
          input.rootTaskId,
          parentTask?.runtimeOwnerSessionKey ?? input.runtimeOwnerSessionKey,
          input.kind,
          input.generationDepth,
          input.generationLimit,
          input.inputHash,
          input.inputText,
          input.cwd,
          input.actorId,
          budgetScopeId,
          JSON.stringify(ancestorScopeIds),
          input.workspaceId,
          input.isolation,
          'creating',
          1,
          CHILD_CONTROL_FORMAT,
          input.attemptId ?? `legacy:${input.writerRunId}`,
          'creating',
          1,
          input.attemptStartedAt ?? clock(),
          null,
          null,
        )
        q.insertWs.run(input.workspaceId, input.childKey, input.isolation, input.cwd, 'planned')
        mark()
        return { status: 'created', record: parseTask(q.task.get(input.childKey) as Record<string, unknown>) }
      })
    },
    async bumpWriterGeneration(key) {
      return tx(() => {
        q.bumpWriter.run(key)
        return (q.writerGen.get(key) as { generation: number }).generation
      })
    },
    async writerGeneration(key) {
      return (q.writerGen.get(key) as { generation: number } | undefined)?.generation ?? 1
    },
    async peekReservation(permitId) {
      return reservationOf(q.res.get(permitId) as Record<string, unknown> | undefined)
    },
    async lookupReservationByIdentity(rootTaskId, effectId, requestHash) {
      return reservationOf(
        q.resByIdentity.get(rootTaskId, effectId, requestHash) as Record<string, unknown> | undefined,
      )
    },
    async updateWorkspace(workspaceId, patch) {
      tx(() => {
        const row = q.workspace.get(workspaceId) as
          | { phase: string; path: string; root: string | null; branch: string | null; child_key: string }
          | undefined
        if (!row) return
        const path = patch.path ?? row.path
        q.updateWs.run(
          patch.phase ?? row.phase,
          path,
          patch.root ?? row.root,
          patch.branch ?? row.branch,
          workspaceId,
        )
        if (patch.path !== undefined) q.updateTaskCwd.run(patch.path, row.child_key)
      })
    },
    async lookupWorkspaceByPath(path) {
      return parseWorkspace(q.wsByPath.get(path) as WorkspaceRow | undefined)
    },
    async reserve(req: ReserveRequest): Promise<ReserveResult> {
      return tx(() => {
        assertWritable()
        if (req.qMicro < 0n) return { ok: false, reason: 'invalid', message: 'reservation is negative' }
        const currentGen =
          (q.writerGen.get(req.rootTaskId) as { generation: number } | undefined)?.generation ?? 1
        if (req.writerGeneration !== currentGen)
          return { ok: false, reason: 'invalid', message: 'writer generation is not current' }
        const prior = reservationOf(
          q.resByEffect.get(req.rootTaskId, req.effectId) as Record<string, unknown> | undefined,
        )
        if (prior) {
          const sameScopes =
            prior.scopeIds.length === req.scopeIds.length &&
            prior.scopeIds.every((scopeId, index) => scopeId === req.scopeIds[index])
          if (
            prior.requestHash !== req.requestHash ||
            prior.qMicro !== req.qMicro ||
            prior.writerGeneration !== req.writerGeneration ||
            !sameScopes
          )
            return {
              ok: false,
              reason: 'invalid',
              message: 'reservation effect identity conflicts with its durable binding',
            }
          return { ok: true, permitId: prior.permitId, status: prior.status, existing: true }
        }
        const scopes: Array<NonNullable<ReturnType<typeof scopeOf>>> = []
        for (const id of req.scopeIds) {
          const scope = scopeOf(id)
          if (!scope) return { ok: false, reason: 'invalid', message: 'unknown budget scope' }
          scopes.push(scope)
        }
        for (const scope of scopes) {
          if (!fitsCap(scope.settledMicro, scope.heldMicro, req.qMicro, scope.capMicro))
            return { ok: false, reason: 'cap', message: `reservation exceeds cap on ${scope.scopeId}` }
        }
        for (const scope of scopes) {
          q.updateScope.run(
            scope.settledMicro.toString(),
            addMicro(scope.heldMicro, req.qMicro).toString(),
            scope.scopeId,
          )
        }
        const last = q.maxPermit.get() as { permit_id: string } | undefined
        const n = last?.permit_id ? Number(last.permit_id.slice(1)) : 0
        const permitId = `p${Number.isFinite(n) ? n + 1 : Date.now()}`
        q.insertRes.run(
          permitId,
          req.rootTaskId,
          JSON.stringify(req.scopeIds),
          req.qMicro.toString(),
          req.effectId,
          req.requestHash,
          req.writerGeneration,
          'held',
        )
        return { ok: true, permitId, status: 'held', existing: false }
      })
    },
    async takeoverReservation(permitId, expectedWriterGeneration) {
      return tx(() => {
        const reservation = reservationOf(q.res.get(permitId) as Record<string, unknown> | undefined)
        if (reservation?.status !== 'held')
          throw new CoreError('E_BUDGET', 'only a held reservation can be taken over', { permitId })
        const current =
          (q.writerGen.get(reservation.rootTaskId) as { generation: number } | undefined)?.generation ?? 1
        const held = (q.heldResByRoot.all(reservation.rootTaskId) as Array<Record<string, unknown>>).map(
          reservationOf,
        )
        if (
          current !== expectedWriterGeneration ||
          held.some((candidate) => candidate?.writerGeneration !== expectedWriterGeneration)
        )
          throw new CoreError('E_BUDGET', 'stale reservation writer generation', { permitId })
        q.bumpWriter.run(reservation.rootTaskId)
        const next = current + 1
        const changed = q.updateHeldGeneration.run(next, reservation.rootTaskId, expectedWriterGeneration)
        if (Number(changed.changes) !== held.length)
          throw new CoreError('E_BUDGET', 'reservation takeover compare-and-swap failed', { permitId })
        return { ...reservation, writerGeneration: next }
      })
    },
    async settleOrigin(req: SettleRequest): Promise<void> {
      let overrun = false
      tx(() => {
        const reservation = reservationOf(q.res.get(req.permitId) as Record<string, unknown> | undefined)
        if (!reservation) throw new CoreError('E_BUDGET', 'unknown reservation', { permitId: req.permitId })
        const currentGen =
          (q.writerGen.get(reservation.rootTaskId) as { generation: number } | undefined)?.generation ?? 1
        if (
          req.writerGeneration !== undefined &&
          (req.writerGeneration !== reservation.writerGeneration || req.writerGeneration !== currentGen)
        )
          throw new CoreError('E_BUDGET', 'stale reservation writer generation', {
            permitId: req.permitId,
          })
        const originKey = `${req.originSessionKey}:${req.originCostSeq}`
        const prior = q.origin.get(originKey) as { micro: string; scope_ids: string } | undefined
        const expectedOrigin = originEnvelope(reservation)
        const actualKey = req.actualMicro === null ? 'unknown' : req.actualMicro.toString()
        if (prior) {
          let priorEnvelope: unknown
          try {
            priorEnvelope = JSON.parse(prior.scope_ids)
          } catch {
            priorEnvelope = null
          }
          if (prior.micro !== actualKey || !sameOriginEnvelope(priorEnvelope, expectedOrigin))
            throw new CoreError('E_BUDGET', 'cost origin conflicts with its durable reservation binding', {
              permitId: req.permitId,
            })
          return
        }
        if (reservation.status === 'settled' || reservation.status === 'released')
          throw new CoreError('E_BUDGET', 'permit already consumed', {
            permitId: req.permitId,
            status: reservation.status,
          })
        if (req.actualMicro === null) {
          q.updateRes.run('unknown', req.permitId)
          q.insertOrigin.run(originKey, 'unknown', JSON.stringify(expectedOrigin))
          return
        }
        const qMicro = reservation.qMicro
        if (req.actualMicro > qMicro) {
          for (const id of reservation.scopeIds) {
            const scope = scopeOf(id)
            if (!scope) continue
            const held = scope.heldMicro >= qMicro ? scope.heldMicro - qMicro : 0n
            q.updateScope.run(addMicro(scope.settledMicro, req.actualMicro).toString(), held.toString(), id)
          }
          q.updateRes.run('unknown', req.permitId)
          q.insertOrigin.run(originKey, req.actualMicro.toString(), JSON.stringify(expectedOrigin))
          overrun = true
          return
        }
        for (const id of reservation.scopeIds) {
          const scope = scopeOf(id)
          if (!scope) continue
          if (scope.heldMicro < qMicro)
            throw new CoreError('E_BUDGET', 'held balance would go negative', { scopeId: id })
          q.updateScope.run(
            addMicro(scope.settledMicro, req.actualMicro).toString(),
            (scope.heldMicro - qMicro).toString(),
            id,
          )
        }
        q.updateRes.run('settled', req.permitId)
        q.insertOrigin.run(originKey, req.actualMicro.toString(), JSON.stringify(expectedOrigin))
      })
      if (overrun)
        throw new CoreError('E_BUDGET', 'settled cost overruns reservation', { permitId: req.permitId })
    },
    async releaseReservation(request) {
      tx(() => {
        const permitId = typeof request === 'string' ? request : request.permitId
        const reservation = reservationOf(q.res.get(permitId) as Record<string, unknown> | undefined)
        if (typeof request !== 'string' && reservation) {
          const currentGen =
            (q.writerGen.get(reservation.rootTaskId) as { generation: number } | undefined)?.generation ?? 1
          if (
            request.writerGeneration !== reservation.writerGeneration ||
            request.writerGeneration !== currentGen
          )
            throw new CoreError('E_BUDGET', 'stale reservation writer generation', { permitId })
        }
        if (reservation?.status !== 'held') return
        const qMicro = reservation.qMicro
        for (const id of reservation.scopeIds) {
          const scope = scopeOf(id)
          if (scope)
            q.updateScope.run(scope.settledMicro.toString(), (scope.heldMicro - qMicro).toString(), id)
        }
        q.updateRes.run('released', permitId)
      })
    },
    async projectTree(rootTaskId): Promise<TreeUsage | null> {
      const root = scopeOf(`root:${rootTaskId}`)
      if (!root) return null
      const unknownHeld = (q.resByRoot.all(rootTaskId) as Array<{ status: string }>).some(
        (r) => r.status === 'unknown',
      )
      return {
        settledMicro: root.settledMicro,
        heldMicro: root.heldMicro,
        capMicro: root.capMicro,
        unknownHeld,
      }
    },
  }
  return store
}
