import { admitFanOut, inheritAncestorScopeIds } from '../child/admission.js'
import { addMicro, fitsCap } from '../child/credits.js'
import type { ChildControlStore } from '../child/store.js'
import {
  type BeginChildAttemptInput,
  type BudgetScopeRecord,
  type CancelCreatingChildInput,
  type CancelledChildFact,
  CHILD_CONTROL_FORMAT,
  type ChildCreationCasInput,
  type ChildTaskRecord,
  type CostOriginBinding,
  type CreateDelegatedChildInput,
  type CreateDelegatedChildResult,
  canTransitionChildState,
  type DeferCreatingChildInput,
  type DeferredChildFact,
  isActiveChildState,
  type PlannedWorkspace,
  type ReservationRecord,
  type ReserveRequest,
  type ReserveResult,
  type SettleRequest,
  type TreeUsage,
} from '../child/types.js'
import { type Clock, CoreError, type Event, type Seq, type SessionKey } from '../types.js'
import {
  type CommitReceipt,
  type CommitTx,
  type IntegrityMetadata,
  type IntegrityRow,
  type IntegrityScanQuery,
  type LeaseClaim,
  type OpenResult,
  RegisterMap,
  type RegisterRow,
  registerKey,
  SCAN_PAGE_MAX,
  type ScanQuery,
  type StorageAdapter,
  scanTruncated,
} from './storage.js'

type Book = {
  events: Event[]
  integrity: Map<Seq, IntegrityMetadata>
  registers: RegisterMap
  /** Whether a durable session row would already exist for this key. */
  opened?: true
  // The claim's own `ttlMs` travels with the lease: renewal resets the full term, so without it
  // `renew()` could only ever preserve the time already remaining and the lease would still lapse
  // while its holder is alive and renewing on schedule.
  // Explicitly `| undefined`: releasing a lease writes undefined back, which the repo's
  // exactOptionalPropertyTypes setting does not allow for a merely optional property.
  lease?: { runId: string; until: number; ttlMs: number } | undefined
  parent?: { key: SessionKey; boundarySeq: Seq }
  /** Program-counter cells written as cells, by lane. A child never sees its parent's. */
  opCells?: Map<string, RegisterRow>
}

/**
 * In-process reference implementation of the storage contract: the durable adapters are expected to
 * reproduce exactly these semantics (lease fencing, register CAS, read-only parent prefix).
 */
export class MemoryStorage implements StorageAdapter, ChildControlStore {
  private readonly books = new Map<SessionKey, Book>()
  private readonly clock: Clock
  private controlFormat: number
  private readonly childTasks = new Map<SessionKey, ChildTaskRecord>()
  private readonly creationIndex = new Map<string, SessionKey>()
  private readonly scopes = new Map<string, BudgetScopeRecord>()
  private readonly reservations = new Map<string, ReservationRecord>()
  private readonly origins = new Map<string, CostOriginBinding>()
  private readonly workspaces = new Map<string, PlannedWorkspace>()
  private readonly ordinals = new Map<string, number>()
  private readonly writerGens = new Map<SessionKey, number>()
  private permitSeq = 0

  constructor(opts: { clock?: Clock; childControlFormat?: number } = {}) {
    this.clock = opts.clock ?? (() => Date.now())
    this.controlFormat = opts.childControlFormat ?? 1
  }

  private book(key: SessionKey): Book {
    let b = this.books.get(key)
    if (!b) {
      b = {
        events: [],
        integrity: new Map(),
        registers: new RegisterMap(),
      }
      this.books.set(key, b)
    }
    return b
  }

  /**
   * Seeds a fresh instance from a fixture's event list, as if this were the ledger a killed process
   * left behind: the rows land exactly as given (their own `seq`, not renumbered) and the register
   * table is rebuilt by folding them in order, the same as a real adapter would on restart. No lease
   * is set, so the first `open()` against this key claims it the way a fresh writer reopening a
   * crashed session's ledger would - this is what makes it usable as a crash-resume fixture rather
   * than a copy of a live session's storage. Tests that exercise fencing may explicitly seed the
   * killed writer's still-live lease; ordinary fixture loads leave it absent.
   */
  static fromEvents(
    key: SessionKey,
    events: Event[],
    opts: {
      clock?: Clock
      /** Models the durable lease a killed writer left behind; omitted means already expired. */
      lease?: { writerRunId: string; ttlMs: number }
      /** Program-counter cells the killed writer had written as cells; only `op.state` rows. */
      opCells?: RegisterRow[]
    } = {},
  ): MemoryStorage {
    const storage = new MemoryStorage(opts.clock ? { clock: opts.clock } : {})
    const b = storage.book(key)
    b.opened = true
    b.events = [...events]
    for (const e of events)
      if (e.register)
        b.registers.apply({ register: e.register, key: registerKey(e), seq: e.seq, data: e.data })
    for (const row of opts.opCells ?? []) {
      if (row.register !== 'op.state')
        throw new CoreError('E_ENVELOPE', `fixture op cell names register ${row.register}, not op.state`)
      storage.setOpCell(b, row)
    }
    if (opts.lease) {
      const { writerRunId: runId, ttlMs } = opts.lease
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
        throw new CoreError('E_WRITER_LEASE', 'fixture lease ttl must be a positive integer')
      b.lease = { runId, ttlMs, until: storage.clock() + ttlMs }
    }
    return storage
  }

  private assertLease(b: Book, runId: string): void {
    if (!b.lease || b.lease.runId !== runId || b.lease.until < this.clock())
      throw new CoreError('E_WRITER_LEASE', 'writer lease not held', {
        expected: b.lease?.runId ?? null,
        actual: runId,
      })
  }

  /** Holds the lease for a write: extends a held one, or takes back a lapsed or missing one. */
  private holdLease(b: Book, runId: string, claim: LeaseClaim | undefined): void {
    let ttlMs = b.lease?.ttlMs
    try {
      this.assertLease(b, runId)
    } catch (error) {
      if (!claim || (b.lease && b.lease.runId !== runId) || this.lastSeq(b) !== claim.expectedLastSeq)
        throw error
      ttlMs = claim.ttlMs
    }
    if (claim && ttlMs !== undefined) b.lease = { runId, until: this.clock() + ttlMs, ttlMs }
  }

  private lastSeq(b: Book): Seq {
    if (b.events.length) return (b.events[b.events.length - 1] as Event).seq
    // An empty child ledger still starts numbering after the boundary it forked at.
    return b.parent?.boundarySeq ?? 0
  }

  // A child ledger stores no copy of its parent's rows; the parent prefix is spliced onto the read
  // path instead, which is sound because the prefix is append-only below the boundary.
  private prefixed(b: Book): Event[] {
    if (!b.parent) return b.events
    const boundarySeq = b.parent.boundarySeq
    const p = this.book(b.parent.key)
    return [...this.prefixed(p).filter((e) => e.seq <= boundarySeq), ...b.events]
  }

  private prefixedIntegrity(key: SessionKey, b: Book): IntegrityRow[] {
    const own = b.events.map((event) => ({
      sessionKey: key,
      event,
      integrity: b.integrity.get(event.seq) ?? null,
    }))
    if (!b.parent) return own
    const boundarySeq = b.parent.boundarySeq
    return [
      ...this.prefixedIntegrity(b.parent.key, this.book(b.parent.key)).filter(
        (row) => row.event.seq <= boundarySeq,
      ),
      ...own,
    ]
  }

  /**
   * The register cells a reader of this book sees. A child ledger holds only its own rows, so its
   * view is folded from the spliced read path: the parent chain up to the fork boundary, then the
   * child's own rows on top. The fold is replayed rather than copied off the parent's live map,
   * which would leak cells the parent wrote after the fork, and it applies tombstones from either
   * side in seq order. A root book has no prefix, so its incrementally maintained map is the view.
   */
  private registerView(b: Book): RegisterMap {
    if (!b.parent) return b.registers
    const view = new RegisterMap()
    for (const e of this.prefixed(b)) {
      if (e.register) view.apply({ register: e.register, key: registerKey(e), seq: e.seq, data: e.data })
    }
    for (const row of b.opCells?.values() ?? []) view.apply(row)
    return view
  }

  /** Writes one program-counter cell of this book only; a child's view folds its own cells alone. */
  private setOpCell(b: Book, row: RegisterRow): void {
    b.opCells ??= new Map()
    if (row.data === null) b.opCells.delete(row.key)
    else b.opCells.set(row.key, row)
    b.registers.apply(row)
  }

  async open(key: SessionKey, claim: { writerRunId: string; ttlMs: number }): Promise<OpenResult> {
    const created = !this.books.get(key)?.opened
    const b = this.book(key)
    const now = this.clock()
    if (b.lease && b.lease.runId !== claim.writerRunId && b.lease.until >= now)
      throw new CoreError('E_WRITER_LEASE', 'session held by another writer', { holder: b.lease.runId })
    b.lease = { runId: claim.writerRunId, until: now + claim.ttlMs, ttlMs: claim.ttlMs }
    b.opened = true
    return {
      lastSeq: this.lastSeq(b),
      formatVersion: 1,
      ...(created ? { created: true } : {}),
      ...(b.parent ? { parent: b.parent } : {}),
    }
  }

  async commit(key: SessionKey, tx: CommitTx): Promise<CommitReceipt> {
    if (tx.opState && tx.events.length === 0)
      throw new CoreError('E_STORAGE_FAULT', 'an op write needs at least one row in its batch')
    const b = this.book(key)
    const lease = b.lease
    this.holdLease(b, tx.expectedWriterRunId, tx.claim)
    if (tx.expectedRegisterSeq) {
      const { register, key: rk, seq } = tx.expectedRegisterSeq
      const cur = this.registerView(b).get(register, rk)?.seq ?? null
      if (cur !== seq) {
        // A refused write leaves the lease as it was, as the durable adapter's rollback does.
        b.lease = lease
        throw new CoreError('E_CAS', 'register seq mismatch', {
          register,
          key: rk,
          expected: seq,
          actual: cur,
        })
      }
    }
    let seq = this.lastSeq(b)
    const seqs: Seq[] = []
    const stamped = tx.events.map((e) => ({ ...e, seq: ++seq }))
    if (
      tx.integrity &&
      (tx.integrity.length !== stamped.length ||
        tx.integrity.some((entry, index) => entry.seq !== stamped[index]?.seq))
    )
      throw new CoreError('E_STORAGE_FAULT', 'integrity metadata does not match assigned sequences')
    for (const e of stamped) {
      if (e.register)
        b.registers.apply({ register: e.register, key: registerKey(e), seq: e.seq, data: e.data })
      seqs.push(e.seq)
    }
    b.events.push(...stamped)
    for (const entry of tx.integrity ?? []) {
      const { seq: entrySeq, ...metadata } = entry
      b.integrity.set(entrySeq, metadata)
    }
    if (tx.opState) {
      this.setOpCell(b, {
        register: 'op.state',
        key: tx.opState.lane,
        seq,
        data: structuredClone(tx.opState.data),
      })
      return { firstSeq: seqs[0] as Seq, seqs, opState: { seq } }
    }
    return { firstSeq: seqs[0] as Seq, seqs }
  }

  async renew(key: SessionKey, writerRunId: string, claim?: LeaseClaim): Promise<void> {
    const b = this.book(key)
    if (claim) return this.holdLease(b, writerRunId, claim)
    this.assertLease(b, writerRunId)
    const lease = b.lease as { ttlMs: number }
    // A renewal restarts the term. Carrying the remaining time forward instead would leave `until`
    // invariant, so the lease would expire on its original deadline and a second writer could open
    // the same ledger while the first is still appending to it.
    b.lease = { runId: writerRunId, until: this.clock() + lease.ttlMs, ttlMs: lease.ttlMs }
  }

  async release(key: SessionKey, writerRunId: string): Promise<void> {
    const b = this.book(key)
    if (b.lease?.runId === writerRunId) b.lease = undefined
  }

  async scan(key: SessionKey, q: ScanQuery): Promise<Event[]> {
    // An unbounded scan is refused rather than served: the execution and recovery paths read
    // registers and exact seqs, so a query with neither an upper bound nor a limit is a mistake.
    if (q.toSeq === undefined && q.limit === undefined)
      throw new CoreError('E_SCAN_UNBOUNDED', 'scan needs toSeq or limit')
    if (q.limit !== undefined && (!Number.isSafeInteger(q.limit) || q.limit <= 0))
      throw new CoreError('E_SCAN_UNBOUNDED', 'scan limit must be a positive integer')
    const types = q.type === undefined ? undefined : new Set(Array.isArray(q.type) ? q.type : [q.type])
    let rows = this.prefixed(this.book(key)).filter(
      (e) =>
        (q.fromSeq === undefined || e.seq >= q.fromSeq) &&
        (q.toSeq === undefined || e.seq <= q.toSeq) &&
        (!types || types.has(e.type)) &&
        (q.lane === undefined || (e.lane ?? 'main') === q.lane),
    )
    if (q.order === 'desc') rows = [...rows].reverse()
    if (q.limit !== undefined && q.limit <= SCAN_PAGE_MAX) return rows.slice(0, q.limit)
    if (rows.length > SCAN_PAGE_MAX) throw scanTruncated(q)
    return rows
  }

  async scanIntegrity(key: SessionKey, q: IntegrityScanQuery): Promise<IntegrityRow[]> {
    if (!Number.isSafeInteger(q.limit) || q.limit <= 0)
      throw new CoreError('E_SCAN_UNBOUNDED', 'integrity scan needs a positive limit')
    return this.prefixedIntegrity(key, this.book(key))
      .filter((row) => row.event.seq >= q.fromSeq && row.event.seq <= q.toSeq)
      .slice(0, q.limit)
  }

  async registers(key: SessionKey): Promise<RegisterRow[]> {
    return this.registerView(this.book(key)).values()
  }

  async createChild(parentKey: SessionKey, boundarySeq: Seq, childKey: SessionKey): Promise<void> {
    const existing = this.books.get(childKey)
    if (existing) {
      if (existing.parent?.key === parentKey && existing.parent.boundarySeq === boundarySeq) return
      throw new CoreError('E_STORAGE_FAULT', 'child key exists', { childKey })
    }
    const parent = this.book(parentKey)
    if (boundarySeq > this.lastSeq(parent))
      throw new CoreError('E_STORAGE_FAULT', 'boundary beyond parent', { boundarySeq })
    this.books.set(childKey, {
      events: [],
      integrity: new Map(),
      registers: new RegisterMap(),
      opened: true,
      parent: { key: parentKey, boundarySeq },
    })
  }

  async discardNewSession(key: SessionKey, runId: string, claim?: LeaseClaim): Promise<void> {
    const b = this.book(key)
    this.holdLease(b, runId, claim)
    this.books.delete(key)
  }

  async close(): Promise<void> {
    for (const b of this.books.values()) b.lease = undefined
  }

  childControlFormat(): number {
    return this.controlFormat
  }

  assertWritableFormat(): void {
    if (this.controlFormat > CHILD_CONTROL_FORMAT)
      throw new CoreError(
        'E_FORMAT',
        `child control format ${this.controlFormat} is newer than runtime ${CHILD_CONTROL_FORMAT}`,
      )
  }

  async existsSession(key: SessionKey): Promise<boolean> {
    return this.books.has(key)
  }

  async lookupByKey(childKey: SessionKey): Promise<ChildTaskRecord | null> {
    return this.childTasks.get(childKey) ?? null
  }

  async lookupByCreationId(creationId: string): Promise<ChildTaskRecord | null> {
    const key = this.creationIndex.get(creationId)
    return key ? (this.childTasks.get(key) ?? null) : null
  }

  async listByParent(parentKey: SessionKey): Promise<ChildTaskRecord[]> {
    return [...this.childTasks.values()].filter((row) => row.parentKey === parentKey)
  }

  async listByRoot(rootTaskId: string): Promise<ChildTaskRecord[]> {
    return [...this.childTasks.values()].filter((row) => row.rootTaskId === rootTaskId)
  }

  async listCreatingChildAttempts(): Promise<ChildTaskRecord[]> {
    return [...this.childTasks.values()].filter((row) => row.creationPhase === 'creating')
  }

  async beginChildAttempt(input: BeginChildAttemptInput): Promise<ChildTaskRecord | null> {
    const row = this.childTasks.get(input.childKey)
    if (!row || row.creationId !== input.creationId) return null
    if (
      row.creationPhase === 'creating' &&
      row.attemptId === input.nextAttemptId &&
      row.creationRevision === input.expectedRevision + 1
    )
      return row
    if (
      row.creationPhase !== 'deferred' ||
      row.attemptId !== input.previousAttemptId ||
      row.creationRevision !== input.expectedRevision ||
      !input.nextAttemptId ||
      input.nextAttemptId === input.previousAttemptId
    )
      return null
    row.attemptId = input.nextAttemptId
    row.creationPhase = 'creating'
    row.creationRevision += 1
    row.attemptStartedAt = input.startedAt
    delete row.deferredFact
    delete row.cancelledFact
    return row
  }

  async deferCreatingChild(input: DeferCreatingChildInput): Promise<DeferredChildFact> {
    const row = this.childTasks.get(input.childKey)
    if (
      row?.creationPhase === 'deferred' &&
      row.deferredFact?.attemptId === input.attemptId &&
      row.deferredFact.creationId === input.creationId
    )
      return row.deferredFact
    this.assertCreationCas(row, input, 'creating')
    const fact = Object.freeze({
      childKey: input.childKey,
      creationId: input.creationId,
      attemptId: input.attemptId,
      revision: input.expectedRevision + 1,
      deferredAt: input.deferredAt,
    })
    row.creationPhase = 'deferred'
    row.creationRevision = fact.revision
    row.deferredFact = fact
    return fact
  }

  async commitCreatingChild(input: ChildCreationCasInput): Promise<boolean> {
    const row = this.childTasks.get(input.childKey)
    if (
      row?.creationPhase === 'committed' &&
      row.creationId === input.creationId &&
      row.attemptId === input.attemptId
    )
      return true
    try {
      this.assertCreationCas(row, input, 'creating')
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_CAS') return false
      throw error
    }
    row.creationPhase = 'committed'
    row.creationRevision += 1
    return true
  }

  async cancelCreatingChild(input: CancelCreatingChildInput): Promise<CancelledChildFact> {
    const row = this.childTasks.get(input.childKey)
    if (
      row?.creationPhase === 'cancelled' &&
      row.cancelledFact?.attemptId === input.attemptId &&
      row.cancelledFact.creationId === input.creationId
    )
      return row.cancelledFact
    this.assertCreationCas(row, input, 'creating')
    const fact = Object.freeze({
      childKey: input.childKey,
      creationId: input.creationId,
      attemptId: input.attemptId,
      revision: input.expectedRevision + 1,
      reason: input.reason,
      cancelledAt: input.cancelledAt,
    })
    row.creationPhase = 'cancelled'
    row.creationRevision = fact.revision
    row.cancelledFact = fact
    return fact
  }

  private assertCreationCas(
    row: ChildTaskRecord | undefined,
    input: ChildCreationCasInput,
    expectedPhase: ChildTaskRecord['creationPhase'],
  ): asserts row is ChildTaskRecord {
    if (
      !row ||
      row.creationId !== input.creationId ||
      row.attemptId !== input.attemptId ||
      row.creationRevision !== input.expectedRevision ||
      row.creationPhase !== expectedPhase
    )
      throw new CoreError('E_CAS', 'child creation attempt changed', {
        childKey: input.childKey,
        creationId: input.creationId,
        attemptId: input.attemptId,
        expectedRevision: input.expectedRevision,
      })
  }

  async casState(
    childKey: SessionKey,
    expectedRevision: number,
    next: ChildTaskRecord['state'],
  ): Promise<boolean> {
    const row = this.childTasks.get(childKey)
    if (!row || row.stateRevision !== expectedRevision) return false
    if (!canTransitionChildState(row.state, next)) return false
    row.state = next
    row.stateRevision += 1
    return true
  }

  async nextOrdinal(parentKey: SessionKey, effectId: string): Promise<number> {
    const key = `${parentKey}\0${effectId}`
    const n = (this.ordinals.get(key) ?? 0) + 1
    this.ordinals.set(key, n)
    return n
  }

  async workspace(workspaceId: string): Promise<PlannedWorkspace | null> {
    return this.workspaces.get(workspaceId) ?? null
  }

  async ensureRootScope(rootTaskId: string, capMicro: bigint): Promise<BudgetScopeRecord> {
    this.assertWritableFormat()
    const scopeId = `root:${rootTaskId}`
    const existing = this.scopes.get(scopeId)
    if (existing) return existing
    if (capMicro <= 0n) throw new CoreError('E_BUDGET', 'root tree budget cap must be positive')
    const created: BudgetScopeRecord = {
      scopeId,
      rootTaskId,
      childKey: null,
      parentScopeId: null,
      capMicro,
      settledMicro: 0n,
      heldMicro: 0n,
    }
    this.scopes.set(scopeId, created)
    this.controlFormat = CHILD_CONTROL_FORMAT
    return created
  }

  async scopeForChild(childKey: SessionKey): Promise<BudgetScopeRecord | null> {
    const row = this.childTasks.get(childKey)
    if (!row) return null
    return this.scopes.get(row.budgetScopeId) ?? null
  }

  async createDelegatedChild(input: CreateDelegatedChildInput): Promise<CreateDelegatedChildResult> {
    this.assertWritableFormat()
    const existingKey = this.creationIndex.get(input.creationId)
    if (existingKey) {
      const record = this.childTasks.get(existingKey)
      if (!record) throw new CoreError('E_STORAGE_FAULT', 'creation index missing task', { existingKey })
      return { status: record.inputHash === input.inputHash ? 'existing' : 'conflict', record }
    }
    const parentActive = [...this.childTasks.values()].filter(
      (row) => row.parentKey === input.parentKey && isActiveChildState(row.state),
    ).length
    const rootActive = [...this.childTasks.values()].filter(
      (row) => row.rootTaskId === input.rootTaskId && isActiveChildState(row.state),
    ).length
    const fan = admitFanOut(parentActive, rootActive, input.maxFanOut)
    if (!fan.ok) return { status: 'refused', reason: 'fan_out', message: fan.message }

    const root = this.scopes.get(`root:${input.rootTaskId}`)
    if (!root) return { status: 'refused', reason: 'budget', message: 'tree budget scope is missing' }
    const parentTask = this.childTasks.get(input.parentKey) ?? null
    const ancestorScopeIds = inheritAncestorScopeIds(parentTask, root.scopeId)
    for (const id of ancestorScopeIds) {
      const scope = this.scopes.get(id)
      if (!scope) return { status: 'refused', reason: 'budget', message: `unknown ancestor scope ${id}` }
      if (
        input.childCapMicro !== null &&
        input.childCapMicro > scope.capMicro - scope.settledMicro - scope.heldMicro
      )
        return { status: 'refused', reason: 'budget', message: 'child budget exceeds remaining ancestor cap' }
    }

    const parent = this.books.get(input.parentKey)
    if (!parent) throw new CoreError('E_STORAGE_FAULT', 'parent session missing', { parent: input.parentKey })
    if (this.books.has(input.childKey))
      throw new CoreError('E_STORAGE_FAULT', 'child key exists', { childKey: input.childKey })
    this.books.set(input.childKey, {
      events: [],
      integrity: new Map(),
      registers: new RegisterMap(),
      parent: { key: input.parentKey, boundarySeq: input.boundarySeq },
    })

    let budgetScopeId = parentTask?.budgetScopeId ?? root.scopeId
    if (input.childCapMicro !== null) {
      budgetScopeId = `child:${input.childKey}`
      this.scopes.set(budgetScopeId, {
        scopeId: budgetScopeId,
        rootTaskId: input.rootTaskId,
        childKey: input.childKey,
        parentScopeId: parentTask?.budgetScopeId ?? root.scopeId,
        capMicro: input.childCapMicro,
        settledMicro: 0n,
        heldMicro: 0n,
      })
      ancestorScopeIds.push(budgetScopeId)
    }

    const record: ChildTaskRecord = {
      childKey: input.childKey,
      creationId: input.creationId,
      attemptId: input.attemptId ?? `legacy:${input.writerRunId}`,
      creationPhase: 'creating',
      creationRevision: 1,
      attemptStartedAt: input.attemptStartedAt ?? this.clock(),
      parentKey: input.parentKey,
      rootTaskId: input.rootTaskId,
      runtimeOwnerSessionKey: parentTask?.runtimeOwnerSessionKey ?? input.runtimeOwnerSessionKey,
      kind: input.kind,
      generationDepth: input.generationDepth,
      generationLimit: input.generationLimit,
      boundarySeq: input.boundarySeq,
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
      controlFormat: CHILD_CONTROL_FORMAT,
    }
    this.childTasks.set(input.childKey, record)
    this.creationIndex.set(input.creationId, input.childKey)
    this.workspaces.set(input.workspaceId, {
      workspaceId: input.workspaceId,
      childKey: input.childKey,
      isolation: input.isolation,
      path: input.cwd,
      phase: 'planned',
    })
    this.controlFormat = CHILD_CONTROL_FORMAT
    return { status: 'created', record }
  }

  async bumpWriterGeneration(key: SessionKey): Promise<number> {
    const next = (this.writerGens.get(key) ?? 1) + 1
    this.writerGens.set(key, next)
    return next
  }

  async writerGeneration(key: SessionKey): Promise<number> {
    return this.writerGens.get(key) ?? 1
  }

  async takeoverReservation(permitId: string, expectedWriterGeneration: number): Promise<ReservationRecord> {
    const reservation = this.reservations.get(permitId)
    if (reservation?.status !== 'held')
      throw new CoreError('E_BUDGET', 'only a held reservation can be taken over', { permitId })
    const current = this.writerGens.get(reservation.rootTaskId) ?? 1
    const held = [...this.reservations.values()].filter(
      (candidate) => candidate.rootTaskId === reservation.rootTaskId && candidate.status === 'held',
    )
    if (
      current !== expectedWriterGeneration ||
      held.some((candidate) => candidate.writerGeneration !== expectedWriterGeneration)
    )
      throw new CoreError('E_BUDGET', 'stale reservation writer generation', { permitId })
    const next = current + 1
    this.writerGens.set(reservation.rootTaskId, next)
    for (const candidate of held) candidate.writerGeneration = next
    return { ...reservation, scopeIds: [...reservation.scopeIds] }
  }

  async clearWriterLease(key: SessionKey): Promise<void> {
    const book = this.books.get(key)
    if (book) book.lease = undefined
  }

  async peekReservation(permitId: string): Promise<ReservationRecord | null> {
    return this.reservations.get(permitId) ?? null
  }

  async lookupReservationByIdentity(
    rootTaskId: string,
    effectId: string,
    requestHash: string,
  ): Promise<ReservationRecord | null> {
    return (
      [...this.reservations.values()].find(
        (row) =>
          row.rootTaskId === rootTaskId && row.effectId === effectId && row.requestHash === requestHash,
      ) ?? null
    )
  }

  async updateWorkspace(
    workspaceId: string,
    patch: Partial<Pick<PlannedWorkspace, 'phase' | 'path'>>,
  ): Promise<void> {
    const row = this.workspaces.get(workspaceId)
    if (!row) return
    if (patch.phase !== undefined) row.phase = patch.phase
    if (patch.path !== undefined) {
      row.path = patch.path
      const task = this.childTasks.get(row.childKey)
      if (task) task.cwd = patch.path
    }
  }

  async lookupWorkspaceByPath(path: string): Promise<PlannedWorkspace | null> {
    return [...this.workspaces.values()].find((row) => row.path === path) ?? null
  }

  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    this.assertWritableFormat()
    if (req.qMicro < 0n) return { ok: false, reason: 'invalid', message: 'reservation is negative' }
    const currentGen = this.writerGens.get(req.rootTaskId) ?? 1
    if (req.writerGeneration !== currentGen)
      return { ok: false, reason: 'invalid', message: 'writer generation is not current' }
    const prior = [...this.reservations.values()].find(
      (row) => row.rootTaskId === req.rootTaskId && row.effectId === req.effectId,
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
    const scopes: BudgetScopeRecord[] = []
    for (const id of req.scopeIds) {
      const scope = this.scopes.get(id)
      if (!scope) return { ok: false, reason: 'invalid', message: `unknown budget scope ${id}` }
      scopes.push(scope)
    }
    for (const scope of scopes) {
      if (!fitsCap(scope.settledMicro, scope.heldMicro, req.qMicro, scope.capMicro))
        return { ok: false, reason: 'cap', message: `reservation exceeds cap on ${scope.scopeId}` }
    }
    for (const scope of scopes) scope.heldMicro = addMicro(scope.heldMicro, req.qMicro)
    const permitId = `p${++this.permitSeq}`
    this.reservations.set(permitId, {
      permitId,
      rootTaskId: req.rootTaskId,
      scopeIds: [...req.scopeIds],
      qMicro: req.qMicro,
      effectId: req.effectId,
      requestHash: req.requestHash,
      writerGeneration: req.writerGeneration,
      status: 'held',
    })
    return { ok: true, permitId, status: 'held', existing: false }
  }

  async settleOrigin(req: SettleRequest): Promise<void> {
    const reservation = this.reservations.get(req.permitId)
    if (!reservation) throw new CoreError('E_BUDGET', 'unknown reservation', { permitId: req.permitId })
    const currentGen = this.writerGens.get(reservation.rootTaskId) ?? 1
    if (
      req.writerGeneration !== undefined &&
      (req.writerGeneration !== reservation.writerGeneration || req.writerGeneration !== currentGen)
    )
      throw new CoreError('E_BUDGET', 'stale reservation writer generation', {
        permitId: req.permitId,
      })
    const originKey = `${req.originSessionKey}:${req.originCostSeq}`
    const prior = this.origins.get(originKey)
    if (prior) {
      const sameScopes =
        prior.scopeIds.length === reservation.scopeIds.length &&
        prior.scopeIds.every((scopeId, index) => scopeId === reservation.scopeIds[index])
      if (
        prior.permitId !== reservation.permitId ||
        prior.effectId !== reservation.effectId ||
        prior.requestHash !== reservation.requestHash ||
        prior.writerGeneration !== reservation.writerGeneration ||
        prior.actualMicro !== req.actualMicro ||
        !sameScopes
      )
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
    const actual = req.actualMicro
    if (actual === null) {
      reservation.status = 'unknown'
      this.origins.set(originKey, {
        permitId: reservation.permitId,
        effectId: reservation.effectId,
        requestHash: reservation.requestHash,
        writerGeneration: reservation.writerGeneration,
        actualMicro: null,
        scopeIds: [...reservation.scopeIds],
      })
      return
    }
    if (actual > reservation.qMicro) {
      for (const id of reservation.scopeIds) {
        const scope = this.scopes.get(id)
        if (!scope) continue
        if (scope.heldMicro >= reservation.qMicro) scope.heldMicro -= reservation.qMicro
        scope.settledMicro = addMicro(scope.settledMicro, actual)
      }
      reservation.status = 'unknown'
      this.origins.set(originKey, {
        permitId: reservation.permitId,
        effectId: reservation.effectId,
        requestHash: reservation.requestHash,
        writerGeneration: reservation.writerGeneration,
        actualMicro: actual,
        scopeIds: [...reservation.scopeIds],
      })
      throw new CoreError('E_BUDGET', 'settled cost overruns reservation', {
        permitId: req.permitId,
        actual: actual.toString(),
        reserved: reservation.qMicro.toString(),
      })
    }
    for (const id of reservation.scopeIds) {
      const scope = this.scopes.get(id)
      if (!scope) continue
      if (scope.heldMicro < reservation.qMicro)
        throw new CoreError('E_BUDGET', 'held balance would go negative', { scopeId: id })
      scope.heldMicro -= reservation.qMicro
      scope.settledMicro = addMicro(scope.settledMicro, actual)
    }
    reservation.status = 'settled'
    this.origins.set(originKey, {
      permitId: reservation.permitId,
      effectId: reservation.effectId,
      requestHash: reservation.requestHash,
      writerGeneration: reservation.writerGeneration,
      actualMicro: actual,
      scopeIds: [...reservation.scopeIds],
    })
  }

  async releaseReservation(request: string | { permitId: string; writerGeneration: number }): Promise<void> {
    const permitId = typeof request === 'string' ? request : request.permitId
    const reservation = this.reservations.get(permitId)
    if (typeof request !== 'string' && reservation) {
      const currentGen = this.writerGens.get(reservation.rootTaskId) ?? 1
      if (
        request.writerGeneration !== reservation.writerGeneration ||
        request.writerGeneration !== currentGen
      )
        throw new CoreError('E_BUDGET', 'stale reservation writer generation', { permitId })
    }
    if (reservation?.status !== 'held') return
    for (const id of reservation.scopeIds) {
      const scope = this.scopes.get(id)
      if (scope) scope.heldMicro -= reservation.qMicro
    }
    reservation.status = 'released'
  }

  async projectTree(rootTaskId: string): Promise<TreeUsage | null> {
    const root = this.scopes.get(`root:${rootTaskId}`)
    if (!root) return null
    return {
      settledMicro: root.settledMicro,
      heldMicro: root.heldMicro,
      capMicro: root.capMicro,
      unknownHeld: [...this.reservations.values()].some(
        (row) => row.rootTaskId === rootTaskId && row.status === 'unknown',
      ),
    }
  }
}
