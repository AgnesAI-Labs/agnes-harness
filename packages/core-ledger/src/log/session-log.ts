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
import { makeVerifiedHead } from './verified-head.js'

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
  /** Refuse a pending evidence write when the caller already holds its own writer lock. */
  beforeFullVerify?: 'allow' | 'refuse'
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
  /** Folds open-time checked pages in order; the prefix remains provisional until fullVerified(). */
  verification?: import('./integrity.js').VerificationOptions
  replay?: {
    page(events: Event[]): void
  }
  /** Called once per background full verification, including the one started on open. */
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
  // Verification gates attestations only; execution and appends retain their normal writer gate.
  private fullVerifyState: 'pending' | 'done' | 'failed' | 'stopped' = 'done'
  private fullVerifyPromise: Promise<void> = Promise.resolve()
  private readonly historyChecks = new Set<Promise<number>>()
  private auditTail: Promise<void> = Promise.resolve()
  private checkpointOperations: Promise<void> | undefined
  private readonly verifyAbort = new AbortController()
  /** When the chain this log extends was last hashed in full; 0 when it never was. */
  private verifiedFullAtMs = 0
  private verifiedThroughSeq = 0
  private failureSeq: number | undefined
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
    this.openStats = { lastSeq, checkpoint: { used: false } }
    this.syncRenewal()
  }

  static async open(o: OpenLogOptions): Promise<SessionLogImpl> {
    const opened = await o.storage.open(o.key, { writerRunId: o.writerRunId, ttlMs: o.ttlMs })
    try {
      const failure = await o.storage.readIntegrityFailure?.(o.key)
      if (failure)
        throw new LedgerIntegrityFailure('session history was sealed by a previous verification', failure)
      if (opened.formatVersion !== LEDGER_FORMAT_VERSION) throw ledgerFormatError(o.key, opened.formatVersion)
      // A cold open does not hash the prefix. Every row is checked for sequence and structure while it
      // is folded, the rows after the checkpoint (the last few without one) are hashed, and a replay
      // consumer only sees rows that passed those checks. The full background check starts below;
      // auditHistory requests a fresh check later.
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
      // A checkpoint only accelerates open. Rehash its prefix in this process before attesting it.
      // With no checkpoint, the adopted prefix is never promoted to a verified head here.
      if (opened.lastSeq > 0) log.fullVerifyPromise = log.startBackgroundVerify({ ...integrityState })
      else log.verifiedFullAtMs = o.clock()
      return log
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_LEDGER_INTEGRITY') {
        const seq = error.detail?.seq
        await o.storage
          .writeIntegrityFailure?.(o.key, typeof seq === 'number' ? { seq } : {})
          .catch(() => undefined)
        await o.storage.deleteVerifiedHead?.(o.key).catch(() => undefined)
      }
      await o.storage.release(o.key, o.writerRunId).catch(() => undefined)
      throw error
    }
  }

  /**
   * Opens a delegated child from its live parent without re-reading the parent's history: the chain
   * state at the boundary comes from the parent and may still be provisional. Only the child's own
   * rows are checked here; its inherited prefix is independently verified in the background.
   * ES-private, so no caller can hand in a chain state.
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
      const failure = await o.storage.readIntegrityFailure?.(o.key)
      if (failure)
        throw new LedgerIntegrityFailure('session history was sealed by a previous verification', failure)
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
      log.fullVerifyPromise = log.startBackgroundVerify({ ...own.state })
      return log
    } catch (error) {
      if (error instanceof CoreError && error.code === 'E_LEDGER_INTEGRITY') {
        const seq = error.detail?.seq
        await o.storage
          .writeIntegrityFailure?.(o.key, typeof seq === 'number' ? { seq } : {})
          .catch(() => undefined)
        await o.storage.deleteVerifiedHead?.(o.key).catch(() => undefined)
      }
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

  /** Recheck the tail for a live reload, or start/coalesce a full background rehash for an audit. */
  verifyHistory(
    options: import('./integrity.js').VerificationOptions & { rehashPrefix?: boolean } = {},
  ): Promise<number> {
    const check = this.checkHistory(options)
    this.historyChecks.add(check)
    const finished = () => this.historyChecks.delete(check)
    void check.then(finished, finished)
    return check
  }

  private async checkHistory(
    options: import('./integrity.js').VerificationOptions & { rehashPrefix?: boolean } = {},
  ): Promise<number> {
    if (options.signal?.aborted) throw new CoreError('E_CLOSED', 'ledger verification cancelled')
    this.guard()
    const expected = { ...this.integrityState }
    if (options.rehashPrefix) {
      if (this.fullVerifyState !== 'pending') this.fullVerifyPromise = this.startBackgroundVerify(expected)
      return expected.lastSeq
    }
    try {
      const { state } = await verifyCheckpointHistory(this.storage, this.key, expected.lastSeq, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, this.verifyAbort.signal])
          : this.verifyAbort.signal,
      })
      if (state.headDigest !== expected.headDigest || state.legacyThroughSeq !== expected.legacyThroughSeq)
        throw new LedgerIntegrityFailure('stored history differs from the live head')
      this.guard()
      if (this.fullVerifyState !== 'pending') this.fullVerifyPromise = this.startBackgroundVerify(expected)
      return expected.lastSeq
    } catch (error) {
      // Cancelling a viewer does not change the live verification or its seal.
      if (options.signal?.aborted) throw error
      return this.failVerification(error)
    }
  }

  /** A fresh full audit; the caller waits, ordinary session work does not. */
  auditHistory(signal?: AbortSignal): Promise<import('@agnes/protocol').SessionIntegrityStatus> {
    if (signal?.aborted) return Promise.reject(new CoreError('E_CLOSED', 'audit wait cancelled'))
    // Each request gets a scan started after it arrived. Coalescing with an older scan could miss a
    // row changed after that scan passed it, or newly appended rows beyond its captured cut.
    const audit = this.auditTail.then(async () => {
      await this.fullVerified()
      this.guard()
      this.fullVerifyPromise = this.startBackgroundVerify({ ...this.integrityState })
      await this.fullVerified()
      return this.integrityStatus()
    })
    this.auditTail = audit.then(
      () => undefined,
      () => undefined,
    )
    return waitForVerification(audit, signal)
  }

  integrityStatus(): import('@agnes/protocol').SessionIntegrityStatus {
    return {
      state:
        this.fullVerifyState === 'failed' || this.fullVerifyState === 'stopped'
          ? this.fullVerifyState
          : this.historyChecks.size > 0 || this.fullVerifyState === 'pending'
            ? 'verifying'
            : 'verified',
      verifiedThroughSeq: this.fullVerifyState === 'done' ? this.lastSeq : this.verifiedThroughSeq,
      lastSeq: this.lastSeq,
      legacyThroughSeq: this.integrityState.legacyThroughSeq,
      ...(this.verifiedFullAtMs ? { verifiedAtMs: this.verifiedFullAtMs } : {}),
      ...(this.failureSeq === undefined ? {} : { failureSeq: this.failureSeq }),
    }
  }

  /** Session shutdown cancels the independent verifier before draining operations waiting on it. */
  cancelHistoryVerification(): void {
    this.verifyAbort.abort()
  }

  /**
   * Settles once the current history verification finishes, including a newer live recheck that
   * started while waiting. Rejects with the integrity failure that sealed the log, or with E_CLOSED when the log
   * closed before the background verification finished.
   */
  async fullVerified(): Promise<void> {
    do {
      await Promise.all(this.historyChecks)
      await this.fullVerifyPromise
    } while (this.fullVerifyState === 'pending' || this.historyChecks.size > 0)
    this.guard()
  }

  /**
   * Whether the current history verification has finished. False while a foreground or background
   * verification runs, and for good once it failed or the log closed before it finished.
   */
  get historyVerified(): boolean {
    return (
      this.fullVerifyState === 'done' && this.historyChecks.size === 0 && !this.faultedValue && !this.closed
    )
  }

  /** Forks may use the provisional prefix, but cannot publish after their parent closes or seals. */
  forkCheck(): () => void {
    this.guard()
    return () => this.guard()
  }

  /** Fixed snapshot, small pages, no execution gate. Appends extend its head with hashes we compute. */
  private startBackgroundVerify(expected: IntegrityState): Promise<void> {
    this.fullVerifyState = 'pending'
    this.verifiedThroughSeq = 0
    let measured: FullVerifyReport | undefined
    const report = () => {
      try {
        if (measured) this.o.onFullVerify?.(measured)
      } catch {
        /* advisory only */
      }
    }
    const verified = verifyCheckpointPrefix(
      this.storage,
      this.key,
      { throughSeq: expected.lastSeq, ...expected },
      this.verifyAbort.signal,
      (r) => {
        measured = r
      },
    )
    const completion = verified.then(
      async () => {
        if (this.closed) return this.failVerification(new CoreError('E_CLOSED', 'session closed'))
        this.guard()
        this.fullVerifyState = 'done'
        this.verifiedThroughSeq = expected.lastSeq
        this.verifiedFullAtMs = this.o.clock()
        report()
        // A log that closed meanwhile has handed its lease back; it writes nothing more.
        if (!this.closed) await this.writeHead(true).catch(() => undefined)
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
    const seq = error instanceof CoreError ? error.detail?.seq : undefined
    this.failureSeq = typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : undefined
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
        await this.storage
          .writeIntegrityFailure?.(this.key, this.failureSeq === undefined ? {} : { seq: this.failureSeq })
          .catch(() => undefined)
        await this.storage.deleteVerifiedHead?.(this.key).catch(() => undefined)
      })
      await this.checkpointOperations
    }
    throw failure
  }

  /** Only a fully hashed prefix plus our own hashed appends can become a verified checkpoint. */
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
    // Decisions and final verifier conclusions attest history; ordinary execution remains available.
    const attests = tx.some(attestsHistory)
    if (attests) {
      if (opts.beforeFullVerify === 'refuse') {
        if (!this.historyVerified)
          throw new CoreError(
            'E_LANE_BUSY',
            'verifying history; retry the evidence operation after verification',
          )
      } else await this.fullVerified()
    }
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
      if (events.some(attestsHistory) && !this.historyVerified)
        throw new CoreError(
          'E_LANE_BUSY',
          'verifying history; retry the evidence operation after verification',
        )
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
    this.verifyAbort.abort()
    this.observers.clear()
    this.faultListeners.clear()
    this.timers().clearTimeout(this.timer)
    await this.drain.catch(() => undefined)
    // Never publish a checkpoint for a background verification cancelled by close.
    await this.fullVerifyPromise.catch(() => undefined)
    await this.writeHead().catch(() => undefined)
    await this.checkpointOperations
    if (release) await this.o.storage.release(this.o.key, this.o.writerRunId)
  }
}

/** Evidence-bearing decisions, permission reviews and final gate verdicts use the same ledger fence. */
function attestsHistory(event: EventInput): boolean {
  if (event.type === 'verifier/signal') return (event.data as { scope?: unknown })?.scope === 'turn'
  if (event.type === 'x/core/permission-auto-allowed') return true
  if (event.type === 'x/approval/review') return true
  if (event.register !== 'decision/state') return false
  const data = event.data as {
    result?: { reason?: string }
    consumption?: unknown
    invalidation?: unknown
  } | null
  return !data?.invalidation && (data?.result?.reason === 'answered' || !!data?.consumption)
}
