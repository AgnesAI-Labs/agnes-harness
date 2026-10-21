import {
  type Clock,
  CoreError,
  type Event,
  type EventInput,
  type IdMinter,
  LEDGER_FORMAT_VERSION,
  ledgerFormatError,
  type PreparedEvent,
  type Seq,
  type SessionKey,
} from '@agnes/core-common/types'
import { describeValidationErrors, type ThinkingLevel, validateOpState } from '@agnes/protocol'
import { forkInto, verifiedRange } from './fork-log.js'
import { type ForkBase, forkChecks, seededLogs } from './fork-seed.js'
import {
  type FullVerifyReport,
  verifyCheckpointHistory,
  verifyCheckpointPrefix,
  waitForVerification,
} from './history-verification.js'

import {
  type IntegrityState,
  LEDGER_INTEGRITY_ALGORITHM,
  LedgerIntegrityFailure,
  prepareIntegrity,
} from './integrity.js'
import {
  type CommitReceipt,
  type IntegrityCommit,
  type OpWrite,
  RegisterMap,
  type RegisterRow,
  registerKey,
  type ScanQuery,
  type StorageAdapter,
} from './storage.js'
import { prepareEvents } from './validate.js'
import { makeVerifiedHead, type VerifiedHead } from './verified-head.js'

export type { FullVerifyReport } from './history-verification.js'

export type AppendOptions = {
  /** Backend command authority recheck after queued writes, immediately before storage commit. */
  beforeCommit?: () => void | Promise<void>
  /** Synchronous authority fence after async rechecks, with no await before commit admission. */
  commitCheck?: () => void

  expectedRegisterSeq?: { register: string; key: string; seq: Seq | null }
  refineCaller?: boolean
  /** The program counter of one lane, committed as a register cell at the seq of the batch's last row. */
  opState?: OpWrite
  /**
   * `'allow'` lets the batch through while this log's history is being verified on open or recheck
   * in the background. Only appending user input may ask for it; every other write waits.
   */
  beforeFullVerify?: 'allow'
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
  /** Folds the ledger while `open` verifies it: `page` receives every verified page in order, from seq 1. */
  verification?: import('./integrity.js').VerificationOptions
  replay?: {
    page(events: Event[]): void
  }
  /** Called once per background checkpoint verification, including live rechecks. */
  onFullVerify?: (r: FullVerifyReport) => void
}

/** What opening a session did, for diagnostics and tests: sizes carry no content. */
export type SessionOpenStats = {
  lastSeq: Seq
  checkpoint: { used: boolean; throughSeq?: Seq; reason?: string }
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
  // Whether every row this log opened with has been hashed. An open from a verified-head checkpoint
  // starts 'pending' and verifies the prefix in the background; until it is 'done' only appends of
  // user input are let through. 'failed' seals the log; 'stopped' means it closed first.
  private fullVerifyState: 'pending' | 'done' | 'failed' | 'stopped' = 'done'
  private fullVerifyPromise: Promise<void> = Promise.resolve()
  private checkpointOperations: Promise<void> | undefined
  private readonly verifyAbort = new AbortController()
  /** When this process last finished verifying the full chain it extends. */
  private verifiedFullAtMs: number
  // Whether this process has hashed the whole chain this log extends. Reopening such a log rechecks
  // only the tail after its checkpoint, not the prefix again.
  private chainHashed = false
  /** Set once by `open`; a child opened from a live parent reports the zero value. */
  openStats: SessionOpenStats
  // Appends are serialized through a promise chain rather than run concurrently: seq assignment and
  // the register cache update must observe each batch in commit order. close() awaits the chain,
  // which is what "drain the appends already admitted" means.
  private drain: Promise<void> = Promise.resolve()
  private timer: unknown
  private leaseRenewedAt: number
  private integrityState: IntegrityState
  private readonly createdOnOpen: boolean
  readonly parent: { key: SessionKey; boundarySeq: Seq } | undefined
  recovery: import('./storage.js').OpenResult['recovery']

  private constructor(
    private readonly o: OpenLogOptions,
    lastSeq: Seq,
    rows: RegisterRow[],
    integrityState: IntegrityState,
    createdOnOpen: boolean,
    parent?: { key: SessionKey; boundarySeq: Seq },
  ) {
    this.lastSeqValue = lastSeq
    this.registersCache.replaceAll(rows)
    this.integrityState = integrityState
    this.createdOnOpen = createdOnOpen
    this.parent = parent
    this.leaseRenewedAt = o.clock()
    this.verifiedFullAtMs = this.leaseRenewedAt
    this.openStats = { lastSeq, checkpoint: { used: false } }
    this.syncRenewal()
  }

  static async open(o: OpenLogOptions): Promise<SessionLogImpl> {
    const opened = await o.storage.open(o.key, { writerRunId: o.writerRunId, ttlMs: o.ttlMs })
    try {
      if (opened.formatVersion !== LEDGER_FORMAT_VERSION) throw ledgerFormatError(o.key, opened.formatVersion)
      // The complete integrity chain is verified before any replayed state is exposed; a replay
      // consumer only ever sees rows that have already passed.
      //
      // The one exception is a verified-head checkpoint: the rows it vouches for are folded without
      // being hashed, so history can be shown at once, and the full chain is verified in the
      // background before anything but user input is written (see `append`).
      const replay = o.replay
      const { decision, state: integrityState } = await verifyCheckpointHistory(
        o.storage,
        o.key,
        opened.lastSeq,
        o.verification ?? {},
        // Cold opens still read every row and check contiguity, even without a replay consumer.
        (events) => replay?.page(events),
      )
      const rows = await o.storage.registers(o.key)
      // Opening observers belong to the caller, not to the lifetime of the cached session.
      const { verification: _opening, ...retained } = o
      const log = new SessionLogImpl(
        retained,
        opened.lastSeq,
        rows,
        integrityState,
        opened.created === true,
        opened.parent,
      )
      log.recovery = opened.recovery
      log.openStats = {
        lastSeq: opened.lastSeq,
        checkpoint: decision.use
          ? { used: true, throughSeq: decision.head.throughSeq }
          : { used: false, reason: decision.reason },
      }
      if (decision.use) log.fullVerifyPromise = log.startBackgroundVerify(decision.head)
      else {
        // Everything was verified just now, under this writer's lease, so the head is a verified head.
        // It replaces a checkpoint the open could not use: one past the head would otherwise stay.
        log.chainHashed = true
        void log.writeHead(true).catch(() => undefined)
      }
      return log
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
    checkParent: () => void,
  ): Promise<SessionLogImpl> {
    const opened = await o.storage.open(o.key, { writerRunId: o.writerRunId, ttlMs: o.ttlMs })
    try {
      checkParent()
      if (opened.formatVersion !== LEDGER_FORMAT_VERSION) throw ledgerFormatError(o.key, opened.formatVersion)
      if (
        opened.parent?.key !== parent.key ||
        opened.parent.boundarySeq !== parent.boundarySeq ||
        opened.lastSeq < parent.boundarySeq
      )
        throw new CoreError('E_STORAGE_FAULT', 'child ledger ancestry does not match its live parent', {
          childKey: o.key,
        })
      const own = await verifiedRange(o.storage, o.key, start, opened.lastSeq, checkParent)
      checkParent()
      const rows = await o.storage.registers(o.key)
      checkParent()
      // Opening observers belong to the caller, not to the lifetime of the cached session.
      const { verification: _opening, ...retained } = o
      const log = new SessionLogImpl(
        retained,
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
  get created(): boolean {
    return this.createdOnOpen
  }
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Recheck the tail after the checkpoint now. A prefix this process has not hashed yet is hashed behind
   * the execution gate, as on cold open; one it already hashed is hashed again only when `rehashPrefix`
   * asks for a full recheck. A row changed before the checkpoint of a live log is otherwise found by
   * the next cold open, not by reopening it.
   */
  async verifyHistory(
    options: import('./integrity.js').VerificationOptions & { rehashPrefix?: boolean } = {},
  ): Promise<number> {
    const { rehashPrefix = false, ...verification } = options
    // Serialize verification cycles too: a previous completion must never release a newer gate.
    while (this.fullVerifyState === 'pending')
      await waitForVerification(this.fullVerifyPromise, options.signal)
    if (options.signal?.aborted) throw new CoreError('E_CLOSED', 'ledger verification cancelled')
    this.guard()
    const drain = this.drain
    // Set the gate before the first await, so no step/fork/non-input append can pass during the tail read.
    this.fullVerifyState = 'pending'
    const foreground = (async () => {
      await drain
      this.guard()
      const expected = { ...this.integrityState }
      const result = await verifyCheckpointHistory(this.storage, this.key, expected.lastSeq, {
        ...verification,
        signal: this.verifyAbort.signal,
        onProgress: (progress) => {
          if (!options.signal?.aborted) options.onProgress?.(progress)
        },
      })
      if (
        result.state.headDigest !== expected.headDigest ||
        result.state.legacyThroughSeq !== expected.legacyThroughSeq
      )
        throw new LedgerIntegrityFailure('stored history differs from the live verified head')
      this.guard()
      return { ...result, lastSeq: expected.lastSeq }
    })()
    this.fullVerifyPromise = foreground.then(
      async ({ decision }) => {
        if (this.closed) return this.failVerification(new CoreError('E_CLOSED', 'session closed'))
        if (decision.use && (rehashPrefix || !this.chainHashed))
          await this.startBackgroundVerify(decision.head)
        else {
          this.fullVerifyState = 'done'
          // Without a usable checkpoint the foreground just hashed everything.
          if (!decision.use) this.verifiedFullAtMs = this.o.clock()
          await this.writeHead(!decision.use).catch(() => undefined)
        }
      },
      (error: unknown) => this.failVerification(error),
    )
    this.fullVerifyPromise.catch(() => undefined)
    return waitForVerification(
      foreground.then(({ lastSeq }) => lastSeq),
      options.signal,
    )
  }

  /**
   * Settles once the current history verification finishes, including a newer live recheck that
   * started while waiting. Rejects with the integrity failure that sealed the log, or with E_CLOSED when the log
   * closed before the background verification finished.
   */
  async fullVerified(): Promise<void> {
    do {
      await this.fullVerifyPromise
    } while (this.fullVerifyState === 'pending')
  }

  /**
   * Whether the current history verification has finished. False while a foreground or background
   * verification runs, and for good once it failed or the log closed before it finished.
   */
  get historyVerified(): boolean {
    return this.fullVerifyState === 'done'
  }

  /** A synchronous construction fence; a new verification cycle invalidates the captured fork point. */
  forkCheck(): () => void {
    const cycle = this.fullVerifyPromise
    const check = () => {
      this.guard()
      if (this.fullVerifyState !== 'done' || cycle !== this.fullVerifyPromise)
        throw new CoreError('E_LANE_BUSY', 'parent history verification changed while creating a fork')
    }
    check()
    return check
  }

  /**
   * Hashes the whole chain up to the checkpoint the open folded from, a page at a time and behind
   * other work, and checks it ends at the digest the checkpoint named. Failing seals the log; an
   * integrity failure also drops the checkpoint, so the next open verifies from the first row.
   */
  private startBackgroundVerify(head: VerifiedHead): Promise<void> {
    this.fullVerifyState = 'pending'
    let measured: FullVerifyReport | undefined
    const report = () => {
      try {
        if (measured) this.o.onFullVerify?.(measured)
      } catch {
        /* advisory only */
      }
    }
    const verified = verifyCheckpointPrefix(this.storage, this.key, head, this.verifyAbort.signal, (r) => {
      measured = r
    })
    const completion = verified.then(
      async () => {
        this.fullVerifyState = 'done'
        this.chainHashed = true
        this.verifiedFullAtMs = this.o.clock()
        report()
        // A log that closed meanwhile has handed its lease back; it writes nothing more.
        if (!this.closed) await this.writeHead().catch(() => undefined)
      },
      (error: unknown) => {
        const failed = this.failVerification(error)
        report()
        return failed
      },
    )
    // Waiters see the rejection; this keeps an unobserved one from being reported as unhandled.
    completion.catch(() => undefined)
    return completion
  }

  private async failVerification(error: unknown): Promise<never> {
    const integrity = error instanceof CoreError && error.code === 'E_LEDGER_INTEGRITY'
    if (!integrity && (this.closed || this.verifyAbort.signal.aborted)) {
      this.fullVerifyState = 'stopped'
      throw new CoreError('E_CLOSED', 'session closed before its history was verified')
    }
    this.fullVerifyState = 'failed'
    const failure =
      error instanceof CoreError
        ? error
        : new CoreError('E_STORAGE_FAULT', 'ledger verification could not finish')
    // Seal before awaiting cleanup, so even queued input is refused after a known failure.
    this.markFaulted(failure)
    // Storage outages leave integrity unknown; only a proven integrity failure drops the checkpoint.
    if (integrity) {
      // An older, already admitted write may still be inside storage. Delete only after it settles.
      this.checkpointOperations = (this.checkpointOperations ?? Promise.resolve()).then(async () => {
        await this.storage.deleteVerifiedHead?.(this.key).catch(() => undefined)
      })
      await this.checkpointOperations
    }
    throw failure
  }

  /**
   * Records the in-memory head as the verified head. It is written only once everything up to it has
   * been verified: the rows this log opened with were hashed, and every later row is one this log
   * wrote and chained itself. Storage keeps the furthest one unless `replace` says this one stands.
   */
  private async writeHead(replace = false): Promise<void> {
    const write = this.o.storage.writeVerifiedHead
    if (!write || this.fullVerifyState !== 'done' || this.faultedValue) return
    const s = this.integrityState
    if (s.headDigest === null || s.lastSeq < 1) return
    const head = makeVerifiedHead({
      sessionKey: this.o.key,
      throughSeq: s.lastSeq,
      headDigest: s.headDigest,
      legacyThroughSeq: s.legacyThroughSeq,
      algorithm: LEDGER_INTEGRITY_ALGORITHM,
      verifiedFullAtMs: this.verifiedFullAtMs,
      writtenAtMs: this.o.clock(),
    })
    const invoke = () => write.call(this.o.storage, head, replace ? { force: true } : undefined)
    const pending = this.checkpointOperations ? this.checkpointOperations.then(invoke) : invoke()
    const drained = pending.catch(() => undefined)
    this.checkpointOperations = drained
    void drained.then(() => {
      if (this.checkpointOperations === drained) this.checkpointOperations = undefined
    })
    await pending
  }

  /**
   * Waits for the background verification, then re-checks the log: a batch that waited was never
   * admitted, so one whose log closed meanwhile is refused rather than written after the lease went.
   */
  private async awaitFullVerify(): Promise<void> {
    // Resolves only once the state is 'done'; every other outcome rejects.
    await this.fullVerified()
    this.guard()
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
  }): void {
    this.guard()
    if (this.o.relationCheck || this.o.onAppended)
      throw new CoreError('E_ENVELOPE', 'session log callbacks are already attached')
    this.o.relationCheck = hooks.relationCheck
    this.o.onAppended = hooks.onAppended
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

  /** Throws if the log sealed itself: the integrity failure as itself, any other fault as E_STORAGE_FAULT. */
  sealCheck(): void {
    if (!this.faultedValue) return
    // An integrity failure is reported as itself, so a client can say why the session stopped.
    if (this.faultCause?.code === 'E_LEDGER_INTEGRITY') throw this.faultCause
    throw new CoreError('E_STORAGE_FAULT', 'session is faulted; reopen')
  }

  private guard(): void {
    this.sealCheck()
    if (this.closed) throw new CoreError('E_CLOSED', 'session closed')
  }

  async append(tx: EventInput[], opts: AppendOptions = {}): Promise<{ firstSeq: Seq; seqs: Seq[] }> {
    this.guard()
    // Before the batch is prepared or queued: an allowed batch behind it takes the next seq. Only
    // awaited while pending, so a verified log admits a batch in the same turn as before.
    while (opts.beforeFullVerify !== 'allow' && this.fullVerifyState !== 'done') await this.awaitFullVerify()
    const events = prepareEvents(tx, {
      ids: this.o.ids,
      clock: this.o.clock,
      refineCaller: opts.refineCaller === true,
    })
    const op = opts.opState
    if (op) {
      const checked = validateOpState(op.data)
      if (!checked.ok)
        throw new CoreError('E_ENVELOPE', describeValidationErrors(checked.errors), {
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
      this.o.relationCheck?.(events, this, op)
      if (opts.beforeCommit) await opts.beforeCommit()
      this.o.relationCheck?.(events, this, op)
      this.sealCheck()
      opts.commitCheck?.()
      forkChecks.get(this)?.()
      let committed: CommitReceipt
      const stamped = events.map((e, i) => ({ ...e, seq: this.lastSeqValue + i + 1 }))
      const nextIntegrity = prepareIntegrity(this.o.key, stamped, this.integrityState)
      const claim = { ttlMs: this.o.ttlMs, expectedLastSeq: this.lastSeqValue }
      const writtenAt = this.o.clock()
      try {
        committed = await this.o.storage.commit(this.o.key, {
          events,
          integrity: nextIntegrity.entries,
          expectedWriterRunId: this.o.writerRunId,
          ...(opts.expectedRegisterSeq ? { expectedRegisterSeq: opts.expectedRegisterSeq } : {}),
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
      if (stamped.some((e) => e.type === 'turn/end'))
        queueMicrotask(() => void this.writeHead().catch(() => undefined))
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
      permission?: 'read-only' | 'workspace-write' | 'full-access'
      resolvedProfileHash: string | null
      resolvedPresetHash?: string
      writerRunId: string
      commitCheck?: () => void
      lane: string
      loop?: { id: string; version: string }
      modelSelections?: Array<{
        slot: string
        route: string
        model: string
        thinking?: ThinkingLevel
        contextWindow?: number
      }>
      delegation?: {
        kind: 'fork' | 'spawn'
        creationId: string
        rootTaskId: string
        generationDepth: number
      }
    },
  ): Promise<SessionLogImpl> {
    this.guard()
    while (this.fullVerifyState !== 'done') await this.awaitFullVerify()
    return forkInto(
      this,
      this.o,
      this.integrityState,
      {
        cold: (options) => SessionLogImpl.open(options),
        live: (...args) => SessionLogImpl.#openFromLiveParent(...args),
      },
      boundarySeq,
      childKey,
      opener,
    )
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
    this.verifyAbort.abort()
    await this.writeHead().catch(() => undefined)
    await this.checkpointOperations
    if (release) await this.o.storage.release(this.o.key, this.o.writerRunId)
  }
}
