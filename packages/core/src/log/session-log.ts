import { validateOpState } from '@agnes/protocol'
import { decodeFoldCache } from '../project/cache.js'
import {
  type Clock,
  CoreError,
  type Event,
  type EventInput,
  type IdMinter,
  type PreparedEvent,
  type Seq,
  type SessionKey,
} from '../types.js'
import { type ForkBase, forkBaseProviders, forkPaths, pageYield, seededLogs } from './fork-seed.js'
import {
  INTEGRITY_PAGE_SIZE,
  type IntegrityState,
  LedgerIntegrityFailure,
  prepareIntegrity,
  verifyIntegrityRows,
  verifyLedger,
} from './integrity.js'
import {
  type CommitReceipt,
  type IntegrityCommit,
  type IntegrityRow,
  type OpWrite,
  RegisterMap,
  type RegisterRow,
  registerKey,
  type ScanQuery,
  type StorageAdapter,
} from './storage.js'
import { prepareEvents } from './validate.js'

export type AppendOptions = {
  expectedRegisterSeq?: { register: string; key: string; seq: Seq | null }
  refineCaller?: boolean
  /** The program counter of one lane, committed as a register cell at the seq of the batch's last row. */
  opState?: OpWrite
}

/** What one committed batch carried besides its rows. */
export type AppendedExtra = {
  /** One entry per event; implementers may ignore it. */
  integrity?: readonly IntegrityCommit[]
  /** The program-counter cell this batch wrote, when it wrote one. */
  op?: OpWrite
}

/** Injectable timer pair, so lease renewal can be driven by hand in tests. */
export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type OpenLogOptions = {
  storage: StorageAdapter
  key: SessionKey
  writerRunId: string
  ttlMs: number
  ids: IdMinter
  clock: Clock
  timers?: Timers
  /** `op` is the program-counter cell the batch will write, when it writes one. */
  relationCheck?: (events: PreparedEvent[], log: SessionLogImpl, op: OpWrite | undefined) => void
  onAppended?: (events: Event[], extra: AppendedExtra) => void
  prepareFoldCache?: (
    events: Event[],
    integrity: IntegrityState,
  ) => import('./storage.js').FoldCacheRecord | undefined
  /**
   * Folds the ledger while `open` verifies it. `start` runs once, before the first page, with the
   * verified fold cache when there is one; `page` then receives every verified page in order.
   */
  replay?: {
    start(fold: { seq: Seq; state: import('../reduce/state.js').LedgerState } | undefined): void
    page(events: Event[]): void
  }
}

/**
 * The ledger facade: one writer, one session. It validates a batch before it is offered to storage,
 * keeps the materialized registers in memory so `latest` is O(1), holds the writer lease alive, and
 * seals itself the moment a commit fails so no caller can build on a half-written history.
 */
export class SessionLogImpl {
  private readonly observers = new Set<{
    types: ReadonlySet<string> | '*'
    notify: (events: Event[]) => void
  }>()
  private readonly faultListeners = new Set<(e: CoreError) => void>()
  private faultCause: CoreError | undefined

  /**
   * Privileged post-commit observation; `'*'` observes every type. Copies isolate observers from the
   * live projection cache.
   */
  observeCommitted(types: readonly string[] | '*', notify: (events: Event[]) => void): () => void {
    this.guard()
    const observer = { types: types === '*' ? types : new Set(types), notify }
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  /**
   * Called once when the log seals itself. A listener added after the seal is called on the next
   * microtask; nothing is called once the log is closed. Registering works on a faulted log.
   */
  onFault(fn: (e: CoreError) => void): () => void {
    if (this.closed) return () => undefined
    this.faultListeners.add(fn)
    const cause = this.faultCause
    if (cause)
      queueMicrotask(() => {
        if (this.faultListeners.delete(fn) && !this.closed) fn(cause)
      })
    return () => {
      this.faultListeners.delete(fn)
    }
  }

  private markFaulted(cause: unknown): void {
    if (this.faultedValue) return
    this.faultedValue = true
    this.faultCause =
      cause instanceof CoreError ? cause : new CoreError('E_STORAGE_FAULT', 'session is faulted; reopen')
    const listeners = [...this.faultListeners]
    this.faultListeners.clear()
    for (const fn of listeners) {
      try {
        fn(this.faultCause)
      } catch {
        /* isolated advisory listener */
      }
    }
  }

  private lastSeqValue: Seq
  private readonly registersCache = new RegisterMap()
  private closed = false
  private faultedValue = false
  // Appends are serialized through a promise chain rather than run concurrently: seq assignment and
  // the register cache update must observe each batch in commit order. close() awaits the chain,
  // which is what "drain the appends already admitted" means.
  private drain: Promise<void> = Promise.resolve()
  private timer: unknown
  private leaseRenewedAt: number
  private integrityState: IntegrityState
  private readonly createdOnOpen: boolean
  readonly parent: { key: SessionKey; boundarySeq: Seq } | undefined

  private constructor(
    private readonly o: OpenLogOptions,
    lastSeq: Seq,
    rows: RegisterRow[],
    integrityState: IntegrityState,
    createdOnOpen: boolean,
    parent?: { key: SessionKey; boundarySeq: Seq },
    readonly restoredFold?: { state: import('../reduce/state.js').LedgerState; integrity: IntegrityState },
  ) {
    this.lastSeqValue = lastSeq
    this.registersCache.replaceAll(rows)
    this.integrityState = integrityState
    this.createdOnOpen = createdOnOpen
    this.parent = parent
    this.leaseRenewedAt = o.clock()
    this.syncRenewal()
  }

  static async open(o: OpenLogOptions): Promise<SessionLogImpl> {
    const opened = await o.storage.open(o.key, { writerRunId: o.writerRunId, ttlMs: o.ttlMs })
    try {
      let restoredFold:
        | { state: import('../reduce/state.js').LedgerState; integrity: IntegrityState }
        | undefined
      const record = await o.storage.foldCache?.(o.key)
      if (record) {
        try {
          restoredFold = decodeFoldCache(o.key, record, opened.lastSeq)
          if (record.seq > 0) {
            const [anchor] = await o.storage.scanIntegrity(o.key, {
              fromSeq: record.seq,
              toSeq: record.seq,
              limit: 1,
            })
            if (
              !anchor ||
              anchor.event.seq !== record.seq ||
              (anchor.integrity?.digest ?? null) !== restoredFold.integrity.headDigest
            )
              restoredFold = undefined
          }
        } catch {
          restoredFold = undefined
        }
      }
      // A cache is not a trust anchor: it lives in the same storage as the ledger. Verify the complete
      // integrity chain before any cached state or replayed surface is exposed; a replay consumer only
      // ever sees rows that have already passed.
      const replay = o.replay
      replay?.start(restoredFold ? { seq: restoredFold.state.lastSeq, state: restoredFold.state } : undefined)
      const integrityState = await verifyLedger(
        o.storage,
        o.key,
        opened.lastSeq,
        pageYield,
        replay ? (events) => replay.page(events) : undefined,
      )
      const rows = await o.storage.registers(o.key)
      return new SessionLogImpl(
        o,
        opened.lastSeq,
        rows,
        integrityState,
        opened.created === true,
        opened.parent,
        restoredFold,
      )
    } catch (error) {
      await o.storage.release(o.key, o.writerRunId).catch(() => undefined)
      throw error
    }
  }

  /**
   * Opens a delegated child from its live parent without re-reading the parent's history: the chain
   * state at the boundary comes from the parent, which computed or verified it in this process. Only
   * the child's own rows are read and checked. ES-private, so no caller can hand in a chain state.
   */
  static async #openFromLiveParent(
    o: OpenLogOptions,
    parent: { key: SessionKey; boundarySeq: Seq },
    start: IntegrityState,
    seed: { base: ForkBase; inherited: Event[] },
  ): Promise<SessionLogImpl> {
    const opened = await o.storage.open(o.key, { writerRunId: o.writerRunId, ttlMs: o.ttlMs })
    try {
      if (
        opened.parent?.key !== parent.key ||
        opened.parent.boundarySeq !== parent.boundarySeq ||
        opened.lastSeq < parent.boundarySeq
      )
        throw new CoreError('E_STORAGE_FAULT', 'child ledger ancestry does not match its live parent', {
          childKey: o.key,
        })
      const own = await verifiedRange(o.storage, o.key, start, opened.lastSeq)
      const rows = await o.storage.registers(o.key)
      const log = new SessionLogImpl(
        o,
        opened.lastSeq,
        rows,
        own.state,
        opened.created === true,
        opened.parent,
      )
      seededLogs.set(log, { ...seed, own: own.rows.map((row) => row.event), tail: [] })
      return log
    } catch (error) {
      await o.storage.release(o.key, o.writerRunId).catch(() => undefined)
      throw error
    }
  }

  get storage(): StorageAdapter {
    return this.o.storage
  }

  get key(): SessionKey {
    return this.o.key
  }
  get writerRunId(): string {
    return this.o.writerRunId
  }
  get lastSeq(): Seq {
    return this.lastSeqValue
  }
  get faulted(): boolean {
    return this.faultedValue
  }
  get isClosed(): boolean {
    return this.closed
  }

  /** Import-only compensation: existing sessions are refused and storage rechecks the writer lease. */
  async discardNewSession(): Promise<void> {
    this.guard()
    const discard = this.o.storage.discardNewSession
    if (!this.createdOnOpen || !discard)
      throw new CoreError('E_STORAGE_FAULT', 'this session cannot be discarded for import recovery')
    const claim = { ttlMs: this.o.ttlMs, expectedLastSeq: this.lastSeqValue }
    await this.close(false)
    try {
      await discard(this.o.key, this.o.writerRunId, claim)
    } catch (error) {
      // The log is now closed, so a failed compensation must not strand this writer's lease. The
      // storage implementation fences release by this run id; a different writer's lease survives.
      await this.o.storage.release(this.o.key, this.o.writerRunId).catch(() => undefined)
      throw error
    }
  }

  /**
   * Fits the live projection callbacks onto a child log opened by `forkInto`.
   *
   * A fork has to claim its writer and append `session/start` before the child Session exists, so it
   * cannot receive that Session's tracker callbacks at construction time. They may be attached once
   * before any higher-level caller receives the log; replacing an existing callback would let two
   * trackers silently compete for one ledger.
   */
  attach(hooks: {
    relationCheck: NonNullable<OpenLogOptions['relationCheck']>
    onAppended: NonNullable<OpenLogOptions['onAppended']>
    prepareFoldCache?: NonNullable<OpenLogOptions['prepareFoldCache']>
  }): void {
    this.guard()
    if (this.o.relationCheck || this.o.onAppended)
      throw new CoreError('E_ENVELOPE', 'session log callbacks are already attached')
    this.o.relationCheck = hooks.relationCheck
    this.o.onAppended = hooks.onAppended
    if (hooks.prepareFoldCache) this.o.prepareFoldCache = hooks.prepareFoldCache
  }

  /**
   * How long this writer's lease is still good for, measured from the last renewal that landed. A
   * tool budgeting its own work needs the real deadline: a constant handed out in its place plans
   * against a lease that may already have lapsed.
   */
  leaseRemainingMs(): number {
    return Math.max(0, this.o.ttlMs - (this.o.clock() - this.leaseRenewedAt))
  }

  private timers(): Timers {
    return (
      this.o.timers ?? {
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (h) => globalThis.clearTimeout(h as number),
      }
    )
  }

  /**
   * The timer runs while a turn is open on any lane: crash recovery treats an expired lease with a
   * turn open as a dead writer, so a turn that writes nothing for a while must keep its lease. With
   * no turn open every write renews the lease, or takes a lapsed one back.
   */
  private syncRenewal(): void {
    const wanted = this.registersCache.hasOpLane
    if (wanted && this.timer === undefined) this.scheduleRenew()
    if (!wanted && this.timer !== undefined) {
      this.timers().clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  // Renewal runs on a self-rescheduling one-shot timer at a third of the TTL, so two missed ticks
  // still leave a margin before the lease lapses.
  private scheduleRenew(): void {
    const handle: unknown = this.timers().setTimeout(
      () => {
        // A timer stopped by syncRenewal must not come back to life if it fires anyway.
        if (this.timer !== handle) return
        this.timer = undefined
        if (this.closed || this.faultedValue) return
        void this.o.storage
          .renew(this.o.key, this.o.writerRunId)
          .then(() => {
            this.leaseRenewedAt = this.o.clock()
          })
          .catch((error: unknown) => {
            this.markFaulted(error)
          })
        this.scheduleRenew()
      },
      Math.max(1, Math.floor(this.o.ttlMs / 3)),
    )
    this.timer = handle
  }

  private sealCheck(): void {
    if (this.faultedValue) throw new CoreError('E_STORAGE_FAULT', 'session is faulted; reopen')
  }

  private guard(): void {
    this.sealCheck()
    if (this.closed) throw new CoreError('E_CLOSED', 'session closed')
  }

  async append(tx: EventInput[], opts: AppendOptions = {}): Promise<{ firstSeq: Seq; seqs: Seq[] }> {
    this.guard()
    const events = prepareEvents(tx, {
      ids: this.o.ids,
      clock: this.o.clock,
      refineCaller: opts.refineCaller === true,
    })
    const op = opts.opState
    if (op) {
      const checked = validateOpState(op.data)
      if (!checked.ok)
        throw new CoreError('E_ENVELOPE', checked.errors[0]?.message ?? 'invalid op state', {
          errors: checked.errors,
        })
    }
    this.o.relationCheck?.(events, this, op)
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    const prev = this.drain
    this.drain = prev.then(() => gate)
    try {
      await prev
      // The fault seal is re-checked here, not only on entry: a batch that queued behind an earlier
      // one must not reach storage if that earlier batch sealed the session while this one waited.
      // `closed` is deliberately not re-checked, because close() promises to drain what it admitted.
      this.sealCheck()
      let committed: CommitReceipt
      const stamped = events.map((e, i) => ({ ...e, seq: this.lastSeqValue + i + 1 }))
      const nextIntegrity = prepareIntegrity(this.o.key, stamped, this.integrityState)
      const foldCache = this.o.prepareFoldCache?.(stamped, nextIntegrity.state)
      const claim = { ttlMs: this.o.ttlMs, expectedLastSeq: this.lastSeqValue }
      const writtenAt = this.o.clock()
      try {
        committed = await this.o.storage.commit(this.o.key, {
          events,
          integrity: nextIntegrity.entries,
          expectedWriterRunId: this.o.writerRunId,
          ...(opts.expectedRegisterSeq ? { expectedRegisterSeq: opts.expectedRegisterSeq } : {}),
          ...(foldCache ? { foldCache } : {}),
          ...(op ? { opState: op } : {}),
          claim,
        })
      } catch (err) {
        // A failed CAS means this batch was refused and the ledger is intact. A refused claim means
        // another writer has the session for good, and any other failure leaves the outcome
        // unknown, which is not survivable for an append-only log.
        if (!(err instanceof CoreError && err.code === 'E_CAS')) this.markFaulted(err)
        throw err
      }
      this.leaseRenewedAt = writtenAt
      if (
        committed.seqs.length !== stamped.length ||
        committed.seqs.some((seq, i) => seq !== stamped[i]?.seq) ||
        // An adapter that ignores the op write would drop the program counter without a word.
        (op !== undefined && committed.opState?.seq !== stamped.at(-1)?.seq)
      ) {
        const fault = new CoreError('E_STORAGE_FAULT', 'storage assigned unexpected ledger sequence')
        this.markFaulted(fault)
        throw fault
      }
      for (const e of stamped) {
        if (e.register)
          this.registersCache.apply({
            register: e.register,
            key: registerKey(e),
            seq: e.seq,
            data: e.data,
          })
      }
      this.lastSeqValue = committed.seqs[committed.seqs.length - 1] as Seq
      if (op) {
        this.registersCache.apply({
          register: 'op.state',
          key: op.lane,
          seq: this.lastSeqValue,
          data: op.data,
        })
        this.syncRenewal()
      }
      this.integrityState = nextIntegrity.state
      if (this.o.onAppended)
        this.o.onAppended(stamped, { integrity: nextIntegrity.entries, ...(op ? { op } : {}) })
      else seededLogs.get(this)?.tail.push(...stamped)
      for (const observer of this.observers) {
        const { types } = observer
        const selected = types === '*' ? stamped : stamped.filter((event) => types.has(event.type))
        if (!selected.length) continue
        // An advisory observer must never turn a successful storage commit into an append failure.
        try {
          void Promise.resolve(observer.notify(structuredClone(selected))).catch(() => undefined)
        } catch {
          /* isolated advisory observer */
        }
      }
      return committed
    } finally {
      release()
    }
  }

  /**
   * Holds the writer lease now, taking a lapsed one back as the next write would, in turn with the
   * appends. Seals the log if another writer has the session. For work outside the ledger that must
   * not happen on behalf of a writer that has already been replaced.
   */
  async claimLease(): Promise<void> {
    this.guard()
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    const prev = this.drain
    this.drain = prev.then(() => gate)
    try {
      await prev
      this.sealCheck()
      const claimedAt = this.o.clock()
      const claim = { ttlMs: this.o.ttlMs, expectedLastSeq: this.lastSeqValue }
      try {
        await this.o.storage.renew(this.o.key, this.o.writerRunId, claim)
      } catch (err) {
        this.markFaulted(err)
        throw err
      }
      this.leaseRenewedAt = claimedAt
    } finally {
      release()
    }
  }

  async scan(q: ScanQuery): Promise<Event[]> {
    this.guard()
    return this.o.storage.scan(this.o.key, q)
  }

  latest(register: string, key = 'main'): unknown {
    return this.registersCache.get(register, key)?.data
  }

  registerRow(register: string, key = 'main'): RegisterRow | undefined {
    return this.registersCache.get(register, key)
  }

  allRegisters(): RegisterRow[] {
    return this.registersCache.values()
  }

  /** The lanes holding a program-counter cell, without copying the register table. */
  opLanes(): Set<string> {
    return this.registersCache.opLanes()
  }

  /**
   * Forks this ledger at an existing row. Storage owns the immutable-prefix view and sequence
   * continuation; the facade owns the child session's first durable row, including its ancestry.
   */
  async forkInto(
    boundarySeq: Seq,
    childKey: SessionKey,
    opener: {
      actor: Event['actor']
      agnesVersion: string
      preset: string | null
      resolvedProfileHash: string | null
      writerRunId: string
      lane: string
      modelSelections?: Array<{ slot: string; route: string; model: string }>
      delegation?: {
        kind: 'fork' | 'spawn'
        creationId: string
        rootTaskId: string
        generationDepth: number
      }
    },
  ): Promise<SessionLogImpl> {
    this.guard()
    if (!Number.isSafeInteger(boundarySeq) || boundarySeq < 1 || boundarySeq > this.lastSeqValue)
      throw new CoreError('E_SURFACE_RANGE', 'fork boundary out of range', {
        boundarySeq,
        lastSeq: this.lastSeqValue,
      })

    // A delegated child of a live parent starts from the parent's own state at a fork point at or
    // before the boundary. The point is taken synchronously, before anything else can append.
    const provider = opener.delegation ? forkBaseProviders.get(this) : undefined
    const base = provider?.(boundarySeq, opener.lane)
    let boundaryState: IntegrityState | undefined
    let inherited: IntegrityRow[] = []
    if (base?.kind === 'head') boundaryState = { ...this.integrityState }
    else if (base?.kind === 'trigger') {
      // This writer appends no legacy rows, so the legacy boundary it opened with still holds at c.
      const atTrigger = {
        lastSeq: base.seq,
        legacyThroughSeq: this.integrityState.legacyThroughSeq,
        headDigest: base.headDigest,
      }
      const range = await verifiedRange(this.o.storage, this.o.key, atTrigger, boundarySeq)
      boundaryState = range.state
      inherited = range.rows
    }
    await this.o.storage.createChild(this.o.key, boundarySeq, childKey)
    // Parent callbacks close over the parent's tracker and surface. The child is attached to its
    // own callbacks by the higher-level session assembler; inheriting these would cross-contaminate
    // the two branch projections as soon as session/start is appended.
    const childOptions: OpenLogOptions = {
      storage: this.o.storage,
      key: childKey,
      writerRunId: opener.writerRunId,
      ttlMs: this.o.ttlMs,
      ids: this.o.ids,
      clock: this.o.clock,
      ...(this.o.timers ? { timers: this.o.timers } : {}),
    }
    const child =
      base && boundaryState
        ? await SessionLogImpl.#openFromLiveParent(
            childOptions,
            { key: this.o.key, boundarySeq },
            boundaryState,
            {
              base,
              inherited: inherited.map((row) => row.event),
            },
          )
        : await SessionLogImpl.open(childOptions)
    if (opener.delegation)
      forkPaths.set(
        child,
        base && boundaryState
          ? { path: 'live-parent' }
          : { path: 'cold-open', reason: provider ? 'no-fork-point' : 'no-tracker' },
      )
    try {
      if (child.lastSeq > boundarySeq) {
        const own = seededLogs.get(child)?.own
        const [start] = own
          ? own
          : await child.scan({ fromSeq: boundarySeq + 1, toSeq: boundarySeq + 1, limit: 1 })
        const parent = (start?.data as { parent?: { key?: unknown; boundarySeq?: unknown } } | null)?.parent
        if (
          start?.type !== 'session/start' ||
          parent?.key !== this.o.key ||
          parent.boundarySeq !== boundarySeq
        )
          throw new CoreError('E_STORAGE_FAULT', 'existing fork child has invalid ancestry start', {
            childKey,
          })
        return child
      }
      await child.append([
        {
          type: 'session/start',
          actor: opener.actor,
          origin: 'system',
          trust: 'trusted',
          data: {
            key: childKey,
            parent: { key: this.o.key, boundarySeq },
            resolvedProfileHash: opener.resolvedProfileHash,
            preset: opener.preset,
            agnesVersion: opener.agnesVersion,
            ...(opener.delegation ? { delegation: opener.delegation } : {}),
          },
        },
        {
          type: 'budget.state',
          actor: opener.actor,
          origin: 'system',
          trust: 'trusted',
          lane: opener.lane,
          register: 'budget.state',
          data: null,
        },
        {
          type: 'inbox',
          actor: opener.actor,
          origin: 'system',
          trust: 'trusted',
          lane: opener.lane,
          register: 'inbox',
          data: null,
        },
        ...(opener.modelSelections ?? []).map(
          (selection): EventInput => ({
            type: 'x/core/model-switch',
            actor: opener.actor,
            origin: 'system',
            trust: 'trusted',
            lane: opener.lane,
            ignorable: true,
            data: {
              slot: selection.slot,
              from: { route: selection.route, model: selection.model },
              to: { route: selection.route, model: selection.model },
              reason: 'fork-origin',
            },
          }),
        ),
      ])
    } catch (err) {
      await child.close().catch(() => undefined)
      throw err
    }
    return child
  }

  /**
   * Replaces the materialized cache with rows folded from the ledger itself, which is what
   * discarding a drifted register table means in-process. The rows go in through the same door every
   * other write uses, so the read side finds them: a reseed that spelled its own composite key would
   * leave every rebuilt register unreadable and lose the state silently on the recovery path.
   *
   * It is gated like a write, because it is one: this class is a root export, so without the gate a
   * consumer can reseed the cache of a log that is closed or faulted, and a reader of `latest` then
   * gets cells no live ledger stands behind.
   */
  replaceRegisterCache(rows: RegisterRow[]): void {
    this.guard()
    this.registersCache.replaceAll(rows)
    this.syncRenewal()
  }

  /** Gives up a log whose opening could not be completed: marks it faulted, stops renewing its lease,
   * then closes it and hands the lease back. */
  async abandon(): Promise<void> {
    this.markFaulted(new CoreError('E_STORAGE_FAULT', 'session open was abandoned'))
    await this.close()
  }

  /** Idempotent. Seals the log against new work, lets what is already admitted finish, then hands
   * the lease back. It writes no event: reopening recovers from the program counter's cell, exactly as after a kill. */
  async close(release = true): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.observers.clear()
    this.faultListeners.clear()
    this.timers().clearTimeout(this.timer)
    await this.drain.catch(() => undefined)
    if (release) await this.o.storage.release(this.o.key, this.o.writerRunId)
  }
}

/** Verifies `(state.lastSeq, toSeq]` of `key` onward from `state`, a page at a time, keeping the rows. */
async function verifiedRange(
  storage: StorageAdapter,
  key: SessionKey,
  from: IntegrityState,
  toSeq: Seq,
): Promise<{ state: IntegrityState; rows: IntegrityRow[] }> {
  let state = from
  const rows: IntegrityRow[] = []
  while (state.lastSeq < toSeq) {
    if (rows.length > 0) await pageYield()
    const page = await storage.scanIntegrity(key, {
      fromSeq: state.lastSeq + 1,
      toSeq,
      limit: INTEGRITY_PAGE_SIZE,
    })
    if (page.length === 0)
      throw new LedgerIntegrityFailure('ledger ended before advertised sequence', { seq: state.lastSeq + 1 })
    // The digests cover each row's own session key, so rows of another ledger that happen to chain
    // from the same head would verify; they are refused by key before they are verified.
    const foreign = page.find((row) => row.sessionKey !== key)
    if (foreign)
      throw new LedgerIntegrityFailure('ledger row belongs to another session', { seq: foreign.event.seq })
    state = verifyIntegrityRows(page, state)
    rows.push(...page)
  }
  if (state.lastSeq !== toSeq)
    throw new LedgerIntegrityFailure('ledger exceeds advertised sequence', { seq: state.lastSeq })
  return { state, rows }
}
