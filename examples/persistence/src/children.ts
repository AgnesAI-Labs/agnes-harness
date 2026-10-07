import type {
  BudgetScopeRecord,
  ChildControlStore,
  ChildCreationCasInput,
  ChildTaskRecord,
  PlannedWorkspace,
  ReservationRecord,
} from '@agnes/extension-api'
import { fail, identity, type Journal } from './journal.js'

type Scope = Omit<BudgetScopeRecord, 'capMicro' | 'settledMicro' | 'heldMicro'> & {
  capMicro: string
  settledMicro: string
  heldMicro: string
}
type Reservation = Omit<ReservationRecord, 'qMicro'> & { qMicro: string }
type Origin = { micro: string; binding: string }
const FORMAT = 4
const ACTIVE = new Set(['creating', 'ready', 'running', 'waiting_approval', 'recovery_pending', 'cancelling'])
const decodeScope = (row: Scope): BudgetScopeRecord => ({
  ...row,
  capMicro: BigInt(row.capMicro),
  settledMicro: BigInt(row.settledMicro),
  heldMicro: BigInt(row.heldMicro),
})
const encodeScope = (row: BudgetScopeRecord): Scope => ({
  ...row,
  capMicro: String(row.capMicro),
  settledMicro: String(row.settledMicro),
  heldMicro: String(row.heldMicro),
})
const decodeReservation = (row: Reservation): ReservationRecord => ({ ...row, qMicro: BigInt(row.qMicro) })

/** All identity, budget and workspace changes share the ledger journal transaction. */
export function childControl(
  db: Journal,
  clock: () => number,
  sessions: { exists(key: string): boolean; create(parent: string, seq: number, key: string): void },
): ChildControlStore {
  const all = <T>(domain: string): T[] =>
    db
      .entries<T>()
      .filter(([id]) => (JSON.parse(id) as string[])[0] === domain)
      .map(([, row]) => row)
  const task = (key: string): ChildTaskRecord | undefined => db.get(identity('child', key))
  const saveTask = (row: ChildTaskRecord): void => db.set(identity('child', row.childKey), row)
  const scope = (id: string): BudgetScopeRecord | undefined => {
    const row = db.get<Scope>(identity('scope', id))
    return row ? decodeScope(row) : undefined
  }
  const saveScope = (row: BudgetScopeRecord): void => db.set(identity('scope', row.scopeId), encodeScope(row))
  const reservation = (id: string): ReservationRecord | undefined => {
    const row = db.get<Reservation>(identity('reservation', id))
    return row ? decodeReservation(row) : undefined
  }
  const saveReservation = (row: ReservationRecord): void =>
    db.set(identity('reservation', row.permitId), { ...row, qMicro: String(row.qMicro) })
  const generation = (root: string): number => db.get(identity('generation', root)) ?? 1
  const assertWritable = (): void => {
    if ((db.get<number>(identity('child-format')) ?? FORMAT) > FORMAT)
      fail('E_FORMAT', 'child-control format is newer than runtime')
  }
  const tx = <T>(fn: () => T): T =>
    db.transaction(() => {
      assertWritable()
      return fn()
    })
  const matches = (
    row: ChildTaskRecord | undefined,
    input: ChildCreationCasInput,
    phase = 'creating',
  ): row is ChildTaskRecord =>
    !!row &&
    row.creationId === input.creationId &&
    row.attemptId === input.attemptId &&
    row.creationPhase === phase &&
    row.creationRevision === input.expectedRevision
  const sameAttempt = (
    row: ChildTaskRecord | undefined,
    input: ChildCreationCasInput,
  ): row is ChildTaskRecord =>
    !!row && row.creationId === input.creationId && row.attemptId === input.attemptId
  const checkGeneration = (row: ReservationRecord, expected: number | undefined): void => {
    if (
      expected !== undefined &&
      (expected !== row.writerGeneration || expected !== generation(row.rootTaskId))
    )
      fail('E_BUDGET', 'stale reservation writer generation')
  }
  return {
    childControlFormat: () => {
      db.guard()
      return db.get<number>(identity('child-format')) ?? FORMAT
    },
    assertWritableFormat: assertWritable,
    async existsSession(key) {
      return sessions.exists(key)
    },
    async lookupByKey(key) {
      return task(key) ?? null
    },
    async lookupByCreationId(id) {
      return all<ChildTaskRecord>('child').find((row) => row.creationId === id) ?? null
    },
    async listByParent(key) {
      return all<ChildTaskRecord>('child').filter((row) => row.parentKey === key)
    },
    async listByRoot(key) {
      return all<ChildTaskRecord>('child').filter((row) => row.rootTaskId === key)
    },
    async listCreatingChildAttempts() {
      return all<ChildTaskRecord>('child').filter((row) => row.creationPhase === 'creating')
    },
    async createDelegatedChild(input) {
      return tx(() => {
        const existing = all<ChildTaskRecord>('child').find((row) => row.creationId === input.creationId)
        if (existing)
          return {
            status: existing.inputHash === input.inputHash ? ('existing' as const) : ('conflict' as const),
            record: existing,
          }
        if (input.generationDepth > input.generationLimit)
          return {
            status: 'refused' as const,
            reason: 'generation' as const,
            message: 'generation limit reached',
          }
        const tasks = all<ChildTaskRecord>('child')
        if (
          tasks.filter((row) => row.parentKey === input.parentKey && ACTIVE.has(row.state)).length >=
            input.maxFanOut ||
          tasks.filter((row) => row.rootTaskId === input.rootTaskId && ACTIVE.has(row.state)).length >=
            input.maxFanOut
        )
          return { status: 'refused' as const, reason: 'fan_out' as const, message: 'fan-out limit reached' }
        const root = scope(`root:${input.rootTaskId}`)
        if (!root)
          return {
            status: 'refused' as const,
            reason: 'budget' as const,
            message: 'tree budget scope is missing',
          }
        const parent = task(input.parentKey)
        const ancestorScopeIds = parent ? [...parent.ancestorScopeIds] : [root.scopeId]
        if (parent && !ancestorScopeIds.includes(parent.budgetScopeId))
          ancestorScopeIds.push(parent.budgetScopeId)
        if (!ancestorScopeIds.includes(root.scopeId)) ancestorScopeIds.unshift(root.scopeId)
        for (const id of ancestorScopeIds) {
          const ancestor = scope(id)
          if (
            !ancestor ||
            (input.childCapMicro !== null &&
              (input.childCapMicro < 0n ||
                input.childCapMicro > ancestor.capMicro - ancestor.settledMicro - ancestor.heldMicro))
          )
            return {
              status: 'refused' as const,
              reason: 'budget' as const,
              message: 'child cap exceeds ancestor balance',
            }
        }
        if (sessions.exists(input.childKey)) fail('E_STORAGE_FAULT', 'child session exists')
        if (all<PlannedWorkspace>('workspace').some((row) => row.workspaceId === input.workspaceId))
          fail('E_STORAGE_FAULT', 'child workspace exists')
        sessions.create(input.parentKey, input.boundarySeq, input.childKey)
        let budgetScopeId = parent?.budgetScopeId ?? root.scopeId
        if (input.childCapMicro !== null) {
          budgetScopeId = `child:${input.childKey}`
          saveScope({
            scopeId: budgetScopeId,
            rootTaskId: input.rootTaskId,
            childKey: input.childKey,
            parentScopeId: parent?.budgetScopeId ?? root.scopeId,
            capMicro: input.childCapMicro,
            settledMicro: 0n,
            heldMicro: 0n,
          })
          ancestorScopeIds.push(budgetScopeId)
        }
        const record: ChildTaskRecord = {
          childKey: input.childKey,
          parentKey: input.parentKey,
          boundarySeq: input.boundarySeq,
          creationId: input.creationId,
          attemptId: input.attemptId ?? `legacy:${input.writerRunId}`,
          creationPhase: 'creating',
          creationRevision: 1,
          attemptStartedAt: input.attemptStartedAt ?? clock(),
          rootTaskId: input.rootTaskId,
          runtimeOwnerSessionKey: parent?.runtimeOwnerSessionKey ?? input.runtimeOwnerSessionKey,
          kind: input.kind,
          generationDepth: input.generationDepth,
          generationLimit: input.generationLimit,
          inputHash: input.inputHash,
          inputText: input.inputText,
          cwd: input.cwd,
          actorId: input.actorId,
          budgetScopeId,
          ancestorScopeIds,
          workspaceId: input.workspaceId,
          isolation: input.isolation,
          state: 'creating',
          stateRevision: 1,
          controlFormat: FORMAT,
        }
        saveTask(record)
        db.set(identity('workspace', input.workspaceId), {
          workspaceId: input.workspaceId,
          childKey: input.childKey,
          isolation: input.isolation,
          path: input.cwd,
          phase: 'planned',
        })
        db.set(identity('child-format'), FORMAT)
        return { status: 'created' as const, record }
      })
    },
    async beginChildAttempt(input) {
      return tx(() => {
        const row = task(input.childKey)
        if (row?.creationId !== input.creationId) return null
        if (
          row.creationPhase === 'creating' &&
          row.attemptId === input.nextAttemptId &&
          row.creationRevision === input.expectedRevision + 1
        )
          return row
        if (
          !input.nextAttemptId ||
          input.nextAttemptId === input.previousAttemptId ||
          !matches(row, { ...input, attemptId: input.previousAttemptId }, 'deferred')
        )
          return null
        const { deferredFact: _deferred, cancelledFact: _cancelled, ...rest } = row
        const next: ChildTaskRecord = {
          ...rest,
          attemptId: input.nextAttemptId,
          creationPhase: 'creating',
          creationRevision: row.creationRevision + 1,
          attemptStartedAt: input.startedAt,
        }
        saveTask(next)
        return next
      })
    },
    async deferCreatingChild(input) {
      return tx(() => {
        const row = task(input.childKey)
        if (sameAttempt(row, input) && row.creationPhase === 'deferred' && row.deferredFact)
          return row.deferredFact
        if (!matches(row, input)) fail('E_CAS', 'child creation compare-and-swap failed')
        const fact = {
          childKey: input.childKey,
          creationId: input.creationId,
          attemptId: input.attemptId,
          revision: input.expectedRevision + 1,
          deferredAt: input.deferredAt,
        }
        saveTask({ ...row, creationPhase: 'deferred', creationRevision: fact.revision, deferredFact: fact })
        return fact
      })
    },
    async commitCreatingChild(input) {
      return tx(() => {
        const row = task(input.childKey)
        if (sameAttempt(row, input) && row.creationPhase === 'committed') return true
        if (!matches(row, input)) return false
        saveTask({ ...row, creationPhase: 'committed', creationRevision: row.creationRevision + 1 })
        return true
      })
    },
    async cancelCreatingChild(input) {
      return tx(() => {
        const row = task(input.childKey)
        if (sameAttempt(row, input) && row.creationPhase === 'cancelled' && row.cancelledFact)
          return row.cancelledFact
        if (!matches(row, input)) fail('E_CAS', 'child creation compare-and-swap failed')
        const fact = {
          childKey: input.childKey,
          creationId: input.creationId,
          attemptId: input.attemptId,
          revision: input.expectedRevision + 1,
          reason: input.reason,
          cancelledAt: input.cancelledAt,
        }
        saveTask({
          ...row,
          creationPhase: 'cancelled',
          creationRevision: fact.revision,
          cancelledFact: fact,
          ...(row.state === 'creating'
            ? {
                state: input.reason === 'open_failed' ? 'failed' : 'cancelled',
                stateRevision: row.stateRevision + 1,
              }
            : {}),
        })
        return fact
      })
    },
    async casState(key, revision, next) {
      return tx(() => {
        const row = task(key)
        if (!row || row.stateRevision !== revision) return false
        if (row.state !== next) {
          if (['cancelled', 'failed', 'completed'].includes(row.state)) return false
          if (row.state === 'cancelling' && next !== 'cancelled' && next !== 'failed') return false
          if (next === 'running' && !['ready', 'waiting_approval', 'creating'].includes(row.state))
            return false
        }
        saveTask({ ...row, state: next, stateRevision: revision + 1 })
        return true
      })
    },
    async nextOrdinal(parent, effect) {
      return tx(() => {
        const id = identity('ordinal', parent, effect)
        const n = (db.get<number>(id) ?? 0) + 1
        db.set(id, n)
        return n
      })
    },
    async ensureRootScope(root, cap) {
      return tx(() => {
        const existing = scope(`root:${root}`)
        if (existing) return existing
        if (cap < 0n) fail('E_BUDGET', 'negative root cap')
        const row = {
          scopeId: `root:${root}`,
          rootTaskId: root,
          childKey: null,
          parentScopeId: null,
          capMicro: cap,
          settledMicro: 0n,
          heldMicro: 0n,
        }
        saveScope(row)
        return row
      })
    },
    async scopeForChild(key) {
      const row = task(key)
      return row ? (scope(row.budgetScopeId) ?? null) : null
    },
    async reserve(input) {
      return tx(() => {
        const invalid = {
          ok: false as const,
          reason: 'invalid' as const,
          message: 'invalid reservation binding',
        }
        if (
          input.qMicro < 0n ||
          input.writerGeneration !== generation(input.rootTaskId) ||
          !input.scopeIds.length ||
          new Set(input.scopeIds).size !== input.scopeIds.length ||
          !input.scopeIds.includes(`root:${input.rootTaskId}`)
        )
          return invalid
        const prior = all<Reservation>('reservation')
          .map(decodeReservation)
          .find((row) => row.rootTaskId === input.rootTaskId && row.effectId === input.effectId)
        if (prior) {
          if (
            prior.requestHash !== input.requestHash ||
            prior.qMicro !== input.qMicro ||
            prior.writerGeneration !== input.writerGeneration ||
            identity(prior.scopeIds) !== identity(input.scopeIds)
          )
            return invalid
          return { ok: true as const, permitId: prior.permitId, status: prior.status, existing: true }
        }
        const scopes: BudgetScopeRecord[] = []
        for (const id of input.scopeIds) {
          const row = scope(id)
          if (!row || row.rootTaskId !== input.rootTaskId) return invalid
          scopes.push(row)
        }
        if (scopes.some((row) => row.settledMicro + row.heldMicro + input.qMicro > row.capMicro))
          return { ok: false as const, reason: 'cap' as const, message: 'reservation exceeds cap' }
        for (const row of scopes) saveScope({ ...row, heldMicro: row.heldMicro + input.qMicro })
        const n = (db.get<number>(identity('permit-counter')) ?? 0) + 1
        db.set(identity('permit-counter'), n)
        const permitId = `p${n}`
        saveReservation({ ...input, permitId, status: 'held' })
        return { ok: true as const, permitId, status: 'held' as const, existing: false }
      })
    },
    async settleOrigin(input) {
      let overrun = false
      tx(() => {
        const row = reservation(input.permitId)
        if (!row) fail('E_BUDGET', 'unknown reservation')
        checkGeneration(row, input.writerGeneration)
        if (input.actualMicro !== null && input.actualMicro < 0n) fail('E_BUDGET', 'negative settlement')
        const id = identity('origin', input.originSessionKey, input.originCostSeq)
        const binding = identity(
          row.permitId,
          row.effectId,
          row.requestHash,
          row.writerGeneration,
          row.scopeIds,
        )
        const micro = input.actualMicro === null ? 'unknown' : String(input.actualMicro)
        const prior = db.get<Origin>(id)
        if (prior) {
          if (prior.micro !== micro || prior.binding !== binding)
            fail('E_BUDGET', 'cost origin conflicts with durable reservation')
          return
        }
        if (row.status === 'settled' || row.status === 'released') fail('E_BUDGET', 'permit already consumed')
        if (input.actualMicro !== null)
          for (const scopeId of row.scopeIds) {
            const balance = scope(scopeId)
            if (!balance || balance.heldMicro < row.qMicro) fail('E_BUDGET', 'invalid held balance')
            saveScope({
              ...balance,
              heldMicro: balance.heldMicro - row.qMicro,
              settledMicro: balance.settledMicro + input.actualMicro,
            })
          }
        overrun = input.actualMicro !== null && input.actualMicro > row.qMicro
        saveReservation({ ...row, status: input.actualMicro === null || overrun ? 'unknown' : 'settled' })
        db.set(id, { micro, binding })
      })
      if (overrun) fail('E_BUDGET', 'settled cost overruns reservation')
    },
    async releaseReservation(input) {
      tx(() => {
        const row = reservation(typeof input === 'string' ? input : input.permitId)
        if (!row) return
        checkGeneration(row, typeof input === 'string' ? undefined : input.writerGeneration)
        if (row.status !== 'held') return
        for (const id of row.scopeIds) {
          const balance = scope(id)
          if (!balance || balance.heldMicro < row.qMicro) fail('E_BUDGET', 'invalid held balance')
          saveScope({ ...balance, heldMicro: balance.heldMicro - row.qMicro })
        }
        saveReservation({ ...row, status: 'released' })
      })
    },
    async projectTree(root) {
      const row = scope(`root:${root}`)
      return row
        ? {
            capMicro: row.capMicro,
            settledMicro: row.settledMicro,
            heldMicro: row.heldMicro,
            unknownHeld: all<Reservation>('reservation').some(
              (r) => r.rootTaskId === root && r.status === 'unknown',
            ),
          }
        : null
    },
    async bumpWriterGeneration(key) {
      return tx(() => {
        const n = generation(key) + 1
        db.set(identity('generation', key), n)
        return n
      })
    },
    async writerGeneration(key) {
      return generation(key)
    },
    async peekReservation(id) {
      return reservation(id) ?? null
    },
    async lookupReservationByIdentity(root, effect, hash) {
      const row = all<Reservation>('reservation').find(
        (r) => r.rootTaskId === root && r.effectId === effect && r.requestHash === hash,
      )
      return row ? decodeReservation(row) : null
    },
    async takeoverReservation(id, expected) {
      return tx(() => {
        const row = reservation(id)
        if (row?.status !== 'held' || generation(row.rootTaskId) !== expected)
          fail('E_BUDGET', 'stale reservation takeover')
        const held = all<Reservation>('reservation')
          .map(decodeReservation)
          .filter((r) => r.rootTaskId === row.rootTaskId && r.status === 'held')
        if (held.some((r) => r.writerGeneration !== expected)) fail('E_BUDGET', 'stale held reservation')
        db.set(identity('generation', row.rootTaskId), expected + 1)
        for (const r of held) saveReservation({ ...r, writerGeneration: expected + 1 })
        return { ...row, writerGeneration: expected + 1 }
      })
    },
    async workspace(id) {
      return db.get<PlannedWorkspace>(identity('workspace', id)) ?? null
    },
    async lookupWorkspaceByPath(path) {
      return all<PlannedWorkspace>('workspace').find((row) => row.path === path) ?? null
    },
    async updateWorkspace(id, patch) {
      tx(() => {
        const row = db.get<PlannedWorkspace>(identity('workspace', id))
        if (!row) return
        db.set(identity('workspace', id), { ...row, ...patch })
        const child = task(row.childKey)
        if (child && patch.path !== undefined) saveTask({ ...child, cwd: patch.path })
      })
    },
  }
}
