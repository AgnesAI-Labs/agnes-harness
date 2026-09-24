import type { Context, Fiber } from '@agnes/cordis'
import type { EntryRow } from './entry-row.js'
import { snapshotEntryRow } from './entry-row.js'
import type { EntryImporter } from './loader.js'

export type InstallationUpdateResult =
  | Readonly<{ status: 'updated' }>
  | Readonly<{ status: 'restored'; cause: unknown }>
  | Readonly<{ status: 'removed'; cause: unknown; fatal: true }>

export interface EntryMountAdapter<TImported, TInstallation> {
  mount(parent: Context, row: Readonly<EntryRow>, imported: TImported): Promise<TInstallation>
  update(current: TInstallation, row: Readonly<EntryRow>): Promise<InstallationUpdateResult>
  unmount(current: TInstallation): Promise<void>
  /** Host-only cleanup for a prepared mount that has not reached `mount()` yet. */
  discard?(imported: TImported): void | Promise<void>
  fiber(current: TInstallation): Fiber
}

export type EntryTreeErrorCode =
  | 'E_ROW_DUPLICATE'
  | 'E_ROW_INVALID'
  | 'E_ROW_UPDATE'
  | 'E_ROW_UPDATE_FATAL'
  | 'E_ROW_TRANSACTION'
  | 'E_ROW_TRANSACTION_STALE'
  | 'E_ROW_TRANSACTION_RECOVERY_REQUIRED'
  | 'E_ROW_STUCK'

/** Stable loader failure with a machine-readable code and the adapter's original cause. */
export class EntryTreeError extends Error {
  override readonly name: string = 'EntryTreeError'

  constructor(
    readonly code: EntryTreeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options)
  }
}

type LiveEntry<TInstallation> = {
  row: Readonly<EntryRow>
  installation: TInstallation
}

interface TransactionMetadata<TImported> {
  readonly tree: object
  readonly discard?: (imported: unknown) => void | Promise<void>
  readonly compensationImporter?: (row: Readonly<EntryRow>) => TImported | PromiseLike<TImported>
  readonly stepTimeoutMs?: number
}

type TransactionRecord<TInstallation> =
  | {
      readonly kind: 'mount'
      readonly id: string
      readonly installation: TInstallation
    }
  | {
      readonly kind: 'update'
      readonly id: string
      readonly previous: LiveEntry<TInstallation>
      attempted: boolean
      completed: boolean
    }
  | {
      readonly kind: 'remove'
      readonly id: string
      readonly previous: LiveEntry<TInstallation>
      attempted: boolean
      completed: boolean
    }

interface InternalTransactionJournal<TInstallation> {
  publicJournal: EntryTreeTransactionJournal
  readonly records: TransactionRecord<TInstallation>[]
  readonly prepared: PreparedEntryTreeTransaction<unknown>
  compensated: boolean
}

const transactionMetadata = new WeakMap<object, TransactionMetadata<unknown>>()
const journalMetadata = new WeakMap<object, InternalTransactionJournal<unknown>>()

export type EntryTreeTransactionOperationKind = 'mount' | 'replace' | 'update' | 'remove'

export interface EntryTreeTransactionOperation {
  readonly kind: EntryTreeTransactionOperationKind
  readonly id: string
  readonly previous?: Readonly<EntryRow>
  readonly next?: Readonly<EntryRow>
}

export interface EntryTreeTransactionPrepareOptions<TImported> {
  /** The importer for the target generation. It never runs an adapter mount. */
  readonly importer?: EntryImporter<TImported>
  /** The importer used to restore rows from the current generation. */
  readonly compensationImporter?: EntryImporter<TImported>
  /** Discard an imported but never mounted descriptor or mount ticket. */
  readonly discard?: (imported: TImported) => void | Promise<void>
  /** Longest a single adapter call may take inside a transaction before it is abandoned. */
  readonly stepTimeoutMs?: number
}

export interface PreparedEntryTreeTransaction<TImported> {
  readonly previousRows: readonly Readonly<EntryRow>[]
  readonly desiredRows: readonly Readonly<EntryRow>[]
  readonly operations: readonly EntryTreeTransactionOperation[]
  readonly baseRevision: number
  readonly targetImports: ReadonlyMap<string, TImported>
  readonly compensationImports: ReadonlyMap<string, TImported>
}

export interface EntryTreeTransactionStep {
  readonly kind: 'mount' | 'update' | 'unmount'
  readonly id: string
  readonly status: 'completed' | 'failed'
}

export interface EntryTreeTransactionJournal {
  readonly previousRows: readonly Readonly<EntryRow>[]
  readonly desiredRows: readonly Readonly<EntryRow>[]
  readonly operations: readonly EntryTreeTransactionOperation[]
  readonly steps: readonly EntryTreeTransactionStep[]
  readonly status: 'committed' | 'compensated' | 'recovery-required'
  readonly compensationError?: unknown
}

export interface EntryTreeHostTransaction<TImported> {
  prepare(
    rows: readonly Readonly<EntryRow>[],
    options?: EntryTreeTransactionPrepareOptions<TImported>,
  ): Promise<PreparedEntryTreeTransaction<TImported>>
  apply(prepared: PreparedEntryTreeTransaction<TImported>): Promise<EntryTreeTransactionJournal>
  compensate(journal: EntryTreeTransactionJournal): Promise<void>
}

/** Host-only factory. The regular `apply()` method intentionally keeps its legacy semantics. */
export function createEntryTreeHostTransaction<TImported, TInstallation>(
  tree: EntryTree<TImported, TInstallation>,
): EntryTreeHostTransaction<TImported> {
  return tree.hostTransaction()
}

export class EntryTreeTransactionError extends EntryTreeError {
  override readonly name = 'EntryTreeTransactionError'

  constructor(
    code: Extract<
      EntryTreeErrorCode,
      'E_ROW_TRANSACTION' | 'E_ROW_TRANSACTION_STALE' | 'E_ROW_TRANSACTION_RECOVERY_REQUIRED'
    >,
    message: string,
    readonly journal: EntryTreeTransactionJournal,
    options?: ErrorOptions,
  ) {
    super(code, message, options)
  }
}

/**
 * Diff normalized rows against the live ordinary plugin tree.
 *
 * EntryTree owns the id-to-installation map. It publishes a new map entry only after mount succeeds;
 * all lifecycle work is delegated to the injected adapter.
 */
export class EntryTree<TImported, TInstallation> {
  #live = new Map<string, LiveEntry<TInstallation>>()
  readonly #parent: Context
  readonly #importer: EntryImporter<TImported>
  readonly #adapter: EntryMountAdapter<TImported, TInstallation>
  #order: string[] = []
  #revision = 0
  #tainted = false

  constructor(
    parent: Context,
    importer: EntryImporter<TImported>,
    adapter: EntryMountAdapter<TImported, TInstallation>,
  ) {
    this.#parent = parent
    this.#importer = importer
    this.#adapter = adapter
  }

  /** Reconcile the live tree to the supplied normalized desired rows. */
  async apply(rows: readonly Readonly<EntryRow>[]): Promise<void> {
    const desired = this.#snapshotDesired(rows)
    const active = desired.filter((row) => !row.disabled)
    const activeIds = new Set(active.map(({ id }) => id))
    try {
      for (const id of [...this.#order].reverse()) {
        if (!activeIds.has(id)) await this.#remove(id)
      }

      for (const row of active) {
        const current = this.#live.get(row.id)
        if (!current) {
          await this.#mount(row)
          continue
        }
        if (current.row.mountIdentity !== row.mountIdentity) {
          await this.#remove(row.id)
          await this.#mount(row)
          continue
        }
        if (Object.is(current.row.config, row.config)) {
          current.row = row
          continue
        }
        await this.#update(row, current)
      }

      this.#order = active.map(({ id }) => id)
    } finally {
      this.#revision++
    }
  }

  /** Return a fresh array containing immutable snapshots of all currently installed rows. */
  currentRows(): readonly Readonly<EntryRow>[] {
    return this.#order.flatMap((id) => {
      const current = this.#live.get(id)
      return current ? [current.row] : []
    })
  }

  /** Return the installed child fiber for one row, if present. */
  fiber(id: string): Fiber | undefined {
    const current = this.#live.get(id)
    return current ? this.#adapter.fiber(current.installation) : undefined
  }

  /**
   * Host-only transaction surface. It is deliberately separate from `apply()`: callers that need
   * compensation must opt into the prepared/journal protocol instead of mistaking the legacy
   * first-error reconciliation for an atomic operation.
   */
  hostTransaction(): EntryTreeHostTransaction<TImported> {
    return Object.freeze({
      prepare: (
        rows: readonly Readonly<EntryRow>[],
        options?: EntryTreeTransactionPrepareOptions<TImported>,
      ) => this.#prepareTransaction(rows, options),
      apply: (prepared: PreparedEntryTreeTransaction<TImported>) => this.#applyTransaction(prepared),
      compensate: (journal: EntryTreeTransactionJournal) => this.#compensateJournal(journal),
    })
  }

  async #mount(row: Readonly<EntryRow>): Promise<void> {
    const imported = await this.#importer(row)
    const installation = await this.#adapter.mount(this.#parent, row, imported)
    this.#live.set(row.id, { row, installation })
    if (!this.#order.includes(row.id)) this.#order.push(row.id)
  }

  async #remove(id: string): Promise<void> {
    const current = this.#live.get(id)
    if (!current) return
    try {
      await this.#adapter.unmount(current.installation)
    } finally {
      this.#live.delete(id)
      this.#order = this.#order.filter((item) => item !== id)
    }
  }

  async #update(row: Readonly<EntryRow>, current: LiveEntry<TInstallation>): Promise<void> {
    let result: InstallationUpdateResult
    try {
      result = await this.#adapter.update(current.installation, row)
    } catch (cause) {
      let failure = cause
      try {
        await this.#adapter.unmount(current.installation)
      } catch (cleanup) {
        failure = new AggregateError([cause, cleanup], 'adapter update and cleanup failed')
      } finally {
        this.#live.delete(row.id)
        this.#order = this.#order.filter((item) => item !== row.id)
      }
      throw new EntryTreeError('E_ROW_UPDATE_FATAL', `row ${row.id} was removed`, {
        cause: failure,
      })
    }

    if (result.status === 'updated') {
      current.row = row
      return
    }
    if (result.status === 'restored') {
      throw new EntryTreeError('E_ROW_UPDATE', `row ${row.id} restored its last-good config`, {
        cause: result.cause,
      })
    }
    if (result.status === 'removed') {
      this.#live.delete(row.id)
      this.#order = this.#order.filter((item) => item !== row.id)
      throw new EntryTreeError('E_ROW_UPDATE_FATAL', `row ${row.id} could not be restored`, {
        cause: result.cause,
      })
    }

    const unreachable: never = result
    throw unreachable
  }

  #snapshotDesired(rows: readonly Readonly<EntryRow>[]): Readonly<EntryRow>[] {
    const desired: Readonly<EntryRow>[] = []
    const ids = new Set<string>()
    for (const input of rows) {
      if (!input || typeof input !== 'object' || typeof input.id !== 'string' || input.id.length === 0) {
        throw new EntryTreeError('E_ROW_INVALID', 'row id must be a non-empty string')
      }
      if (ids.has(input.id)) {
        throw new EntryTreeError('E_ROW_DUPLICATE', `duplicate row id ${input.id}`)
      }
      ids.add(input.id)
      desired.push(snapshotEntryRow(input))
    }
    return desired
  }

  async #prepareTransaction(
    rows: readonly Readonly<EntryRow>[],
    options: EntryTreeTransactionPrepareOptions<TImported> = {},
  ): Promise<PreparedEntryTreeTransaction<TImported>> {
    const desired = Object.freeze(this.#snapshotDesired(rows))
    const active = desired.filter((row) => !row.disabled)
    const activeIds = new Set(active.map(({ id }) => id))
    const previousRows = Object.freeze(this.currentRows().map(snapshotEntryRow))
    const previousById = new Map(previousRows.map((row) => [row.id, row]))
    const operations: EntryTreeTransactionOperation[] = []

    for (const id of [...this.#order].reverse()) {
      if (!activeIds.has(id)) {
        const previous = previousById.get(id)
        if (previous) operations.push({ kind: 'remove', id, previous })
      }
    }
    for (const row of active) {
      const previous = previousById.get(row.id)
      if (!previous) operations.push({ kind: 'mount', id: row.id, next: row })
      else if (previous.mountIdentity !== row.mountIdentity)
        operations.push({ kind: 'replace', id: row.id, previous, next: row })
      else if (!Object.is(previous.config, row.config))
        operations.push({ kind: 'update', id: row.id, previous, next: row })
    }

    // The public operation list exposes the deterministic activation order: mount/replace, update,
    // then remove. The old reverse-order remove list above is retained within that final group.
    operations.sort((left, right) => operationRank(left.kind) - operationRank(right.kind))
    const targetImports = new Map<string, TImported>()
    const compensationImports = new Map<string, TImported>()
    const imported: TImported[] = []
    const importer = options.importer ?? this.#importer
    const compensationImporter = options.compensationImporter ?? this.#importer
    try {
      for (const operation of operations) {
        if (operation.next && (operation.kind === 'mount' || operation.kind === 'replace')) {
          const value = await importer(operation.next)
          targetImports.set(operation.id, value)
          imported.push(value)
        }
        // Old rows are deliberately not imported here. Their verified ticket may carry a linear
        // prebound lease, and authorization can be revoked between prepare and compensation. The
        // compensation importer is retained in the private metadata and called fresh at rollback.
      }
    } catch (cause) {
      const cleanupErrors = await discardImported(imported, options.discard)
      if (cleanupErrors.length)
        throw new AggregateError([cause, ...cleanupErrors], 'transaction preparation failed')
      throw cause
    }

    const prepared = Object.freeze({
      previousRows,
      desiredRows: desired,
      operations: Object.freeze(operations.map((operation) => Object.freeze(operation))),
      baseRevision: this.#revision,
      targetImports,
      compensationImports,
    })
    transactionMetadata.set(prepared, {
      tree: this,
      compensationImporter: async (row) => compensationImporter(row),
      ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
      ...(options.discard || this.#adapter.discard
        ? {
            discard: (imported: unknown) =>
              (options.discard ?? this.#adapter.discard)?.(imported as TImported),
          }
        : {}),
    })
    return prepared
  }

  async #applyTransaction(
    prepared: PreparedEntryTreeTransaction<TImported>,
  ): Promise<EntryTreeTransactionJournal> {
    const metadata = transactionMetadata.get(prepared)
    if (!metadata || metadata.tree !== this || prepared.baseRevision !== this.#revision) {
      await this.#discardPrepared(prepared, metadata?.discard)
      const journal = makeTransactionJournal(prepared, [], 'recovery-required')
      throw new EntryTreeTransactionError(
        'E_ROW_TRANSACTION_STALE',
        'prepared row transaction is stale',
        journal,
      )
    }

    const working = new Map<string, LiveEntry<TInstallation>>()
    for (const [id, entry] of this.#live) working.set(id, { ...entry })
    const original = new Map<string, LiveEntry<TInstallation>>()
    for (const [id, entry] of this.#live) original.set(id, { ...entry })
    const records: TransactionRecord<TInstallation>[] = []
    const steps: EntryTreeTransactionStep[] = []
    const internal: InternalTransactionJournal<TInstallation> = {
      publicJournal: makeTransactionJournal(prepared, [], 'recovery-required'),
      records,
      prepared: prepared as PreparedEntryTreeTransaction<unknown>,
      compensated: false,
    }

    const timeoutMs = metadata.stepTimeoutMs
    try {
      for (const operation of prepared.operations) {
        if (operation.kind !== 'mount' && operation.kind !== 'replace') continue
        const imported = prepared.targetImports.get(operation.id)
        if (imported === undefined) throw new Error(`missing prepared mount for row ${operation.id}`)
        if (operation.kind === 'replace') {
          // The old generation goes first: a new row that claims shared names at start would
          // otherwise strip the old row's registrations while its fiber stays alive.
          const current = this.#live.get(operation.id)
          if (!current || !operation.previous) throw new Error(`missing live row for replace ${operation.id}`)
          const record: TransactionRecord<TInstallation> = {
            kind: 'remove',
            id: operation.id,
            previous: { ...current, row: operation.previous },
            attempted: true,
            completed: false,
          }
          records.push(record)
          try {
            await this.#step(
              this.#adapter.unmount(current.installation),
              timeoutMs,
              `unmount ${operation.id}`,
            )
            record.completed = true
            steps.push({ kind: 'unmount', id: operation.id, status: 'completed' })
          } catch (cause) {
            steps.push({ kind: 'unmount', id: operation.id, status: 'failed' })
            throw cause
          }
        }
        try {
          const installation = await this.#step(
            this.#adapter.mount(this.#parent, operation.next as Readonly<EntryRow>, imported),
            timeoutMs,
            `mount ${operation.id}`,
          )
          records.push({ kind: 'mount', id: operation.id, installation })
          working.set(operation.id, { row: operation.next as Readonly<EntryRow>, installation })
          steps.push({ kind: 'mount', id: operation.id, status: 'completed' })
        } catch (cause) {
          steps.push({ kind: 'mount', id: operation.id, status: 'failed' })
          throw cause
        }
      }

      for (const operation of prepared.operations) {
        if (operation.kind !== 'update') continue
        const current = working.get(operation.id)
        if (!current || !operation.next || !operation.previous) {
          throw new Error(`missing live row for update ${operation.id}`)
        }
        const record: TransactionRecord<TInstallation> = {
          kind: 'update',
          id: operation.id,
          previous: { ...current, row: operation.previous },
          attempted: true,
          completed: false,
        }
        records.push(record)
        try {
          const result = await this.#step(
            this.#adapter.update(current.installation, operation.next),
            timeoutMs,
            `update ${operation.id}`,
          )
          if (result.status !== 'updated') {
            throw new EntryTreeError(
              result.status === 'removed' ? 'E_ROW_UPDATE_FATAL' : 'E_ROW_UPDATE',
              `row ${operation.id} did not accept its new config`,
              { cause: result.cause },
            )
          }
          record.completed = true
          working.set(operation.id, { row: operation.next, installation: current.installation })
          steps.push({ kind: 'update', id: operation.id, status: 'completed' })
        } catch (cause) {
          steps.push({ kind: 'update', id: operation.id, status: 'failed' })
          throw cause
        }
      }

      for (const operation of prepared.operations) {
        if (operation.kind !== 'remove') continue
        const current = this.#live.get(operation.id)
        if (!current || !operation.previous) throw new Error(`missing live row for removal ${operation.id}`)
        const record: TransactionRecord<TInstallation> = {
          kind: 'remove',
          id: operation.id,
          previous: { ...current, row: operation.previous },
          attempted: true,
          completed: false,
        }
        records.push(record)
        try {
          await this.#step(this.#adapter.unmount(current.installation), timeoutMs, `unmount ${operation.id}`)
          record.completed = true
          working.delete(operation.id)
          steps.push({ kind: 'unmount', id: operation.id, status: 'completed' })
        } catch (cause) {
          steps.push({ kind: 'unmount', id: operation.id, status: 'failed' })
          throw cause
        }
      }

      const committed = makeTransactionJournal(prepared, steps, 'committed')
      this.#live = working
      this.#order = prepared.desiredRows.filter((row) => !row.disabled).map(({ id }) => id)
      this.#revision++
      internal.publicJournal = committed
      internal.compensated = true
      journalMetadata.set(committed, internal as unknown as InternalTransactionJournal<unknown>)
      await this.#discardPrepared(prepared, metadata.discard)
      return committed
    } catch (cause) {
      const failed = makeTransactionJournal(prepared, steps, 'recovery-required')
      internal.publicJournal = failed
      const compensationError = await this.#compensateInternal(internal, original)
      await this.#discardPrepared(prepared, metadata.discard)
      if (!compensationError) {
        const compensated = makeTransactionJournal(prepared, steps, 'compensated')
        internal.publicJournal = compensated
        internal.compensated = true
        journalMetadata.set(compensated, internal as unknown as InternalTransactionJournal<unknown>)
        throw new EntryTreeTransactionError(
          'E_ROW_TRANSACTION',
          `row transaction failed and was compensated: ${describeCause(cause)}`,
          compensated,
          { cause },
        )
      }
      const recovery = makeTransactionJournal(prepared, steps, 'recovery-required', compensationError)
      internal.publicJournal = recovery
      journalMetadata.set(recovery, internal as unknown as InternalTransactionJournal<unknown>)
      throw new EntryTreeTransactionError(
        'E_ROW_TRANSACTION_RECOVERY_REQUIRED',
        'row transaction failed and compensation requires recovery',
        recovery,
        { cause: new AggregateError([cause, compensationError], 'row transaction recovery required') },
      )
    }
  }

  async #compensateJournal(journal: EntryTreeTransactionJournal): Promise<void> {
    const internal = journalMetadata.get(journal)
    if (!internal || internal.compensated || journal.status !== 'recovery-required') return
    const error = await this.#compensateInternal(
      internal as unknown as InternalTransactionJournal<TInstallation>,
      new Map(this.#live),
    )
    if (error) throw error
    internal.compensated = true
  }

  async #compensateInternal(
    internal: InternalTransactionJournal<TInstallation>,
    restored: Map<string, LiveEntry<TInstallation>>,
  ): Promise<unknown | undefined> {
    const errors: unknown[] = []
    const prepared = internal.prepared as PreparedEntryTreeTransaction<TImported>
    const timeoutMs = transactionMetadata.get(prepared)?.stepTimeoutMs
    const step = <T>(work: Promise<T>, label: string) => this.#step(work, timeoutMs, label)

    // New fibers must go away before restoring an old provider, otherwise a failed replacement
    // can leave both generations active in the same Cordis root.
    for (const record of [...internal.records].reverse()) {
      if (record.kind !== 'mount') continue
      try {
        await step(this.#adapter.unmount(record.installation), `unmount ${record.id}`)
      } catch (error) {
        errors.push(error)
      }
    }

    for (const record of [...internal.records].reverse()) {
      if (record.kind !== 'remove') continue
      try {
        if (!record.completed)
          await step(this.#adapter.unmount(record.previous.installation), `unmount ${record.id}`)
      } catch (error) {
        errors.push(error)
      }
      try {
        const imported = await this.#freshCompensationImport(prepared, record.previous.row)
        const installation = await step(
          this.#adapter.mount(this.#parent, record.previous.row, imported),
          `mount ${record.id}`,
        )
        restored.set(record.id, { row: record.previous.row, installation })
      } catch (error) {
        errors.push(error)
      }
    }

    for (const record of [...internal.records].reverse()) {
      if (record.kind !== 'update') continue
      try {
        const result = await step(
          this.#adapter.update(record.previous.installation, record.previous.row),
          `update ${record.id}`,
        )
        if (result.status !== 'updated') throw new Error(`row ${record.id} did not restore its old config`)
        restored.set(record.id, { row: record.previous.row, installation: record.previous.installation })
      } catch (error) {
        try {
          await step(this.#adapter.unmount(record.previous.installation), `unmount ${record.id}`)
          const imported = await this.#freshCompensationImport(prepared, record.previous.row)
          const installation = await step(
            this.#adapter.mount(this.#parent, record.previous.row, imported),
            `mount ${record.id}`,
          )
          restored.set(record.id, { row: record.previous.row, installation })
        } catch (restoreError) {
          errors.push(new AggregateError([error, restoreError], `row ${record.id} config recovery failed`))
        }
      }
    }

    if (errors.length) return new AggregateError(errors, 'row transaction compensation failed')
    this.#live = restored
    this.#order = internal.publicJournal.previousRows.map(({ id }) => id)
    this.#revision++
    return undefined
  }

  /** True once an adapter call inside a transaction was abandoned; its fiber may never settle. */
  get tainted(): boolean {
    return this.#tainted
  }

  async #step<T>(work: Promise<T>, timeoutMs: number | undefined, label: string): Promise<T> {
    if (timeoutMs === undefined) return work
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.#tainted = true
        reject(new EntryTreeError('E_ROW_STUCK', `${label} did not settle within ${timeoutMs}ms`))
      }, timeoutMs)
    })
    try {
      return await Promise.race([work, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  async #freshCompensationImport(
    prepared: PreparedEntryTreeTransaction<TImported>,
    row: Readonly<EntryRow>,
  ): Promise<TImported> {
    const metadata = transactionMetadata.get(prepared)
    const importer = metadata?.compensationImporter as
      | ((candidate: Readonly<EntryRow>) => TImported | PromiseLike<TImported>)
      | undefined
    if (importer) return await importer(row)
    const imported = prepared.compensationImports.get(row.id)
    if (imported === undefined) throw new Error(`missing compensation mount for row ${row.id}`)
    return imported
  }

  async #discardPrepared(
    prepared: PreparedEntryTreeTransaction<TImported>,
    discard: ((imported: unknown) => void | Promise<void>) | undefined,
  ): Promise<void> {
    if (!discard) return
    const imported = [...prepared.targetImports.values(), ...prepared.compensationImports.values()]
    const errors = await discardImported(imported, discard as (value: TImported) => void | Promise<void>)
    if (errors.length) throw new AggregateError(errors, 'prepared mount cleanup failed')
  }
}

/** The wrapper keeps the code; the message carries why, so callers need not walk the cause chain. */
function describeCause(cause: unknown): string {
  if (cause instanceof AggregateError && cause.errors.length) return describeCause(cause.errors[0])
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function operationRank(kind: EntryTreeTransactionOperationKind): number {
  if (kind === 'mount' || kind === 'replace') return 0
  if (kind === 'update') return 1
  return 2
}

function makeTransactionJournal<TImported>(
  prepared: PreparedEntryTreeTransaction<TImported>,
  steps: readonly EntryTreeTransactionStep[],
  status: EntryTreeTransactionJournal['status'],
  compensationError?: unknown,
): EntryTreeTransactionJournal {
  return Object.freeze({
    previousRows: prepared.previousRows,
    desiredRows: prepared.desiredRows,
    operations: prepared.operations,
    steps: Object.freeze([...steps]),
    status,
    ...(compensationError === undefined ? {} : { compensationError }),
  })
}

async function discardImported<TImported>(
  imported: readonly TImported[],
  discard: ((imported: TImported) => void | Promise<void>) | undefined,
): Promise<unknown[]> {
  if (!discard) return []
  const errors: unknown[] = []
  for (const value of imported) {
    try {
      await discard(value)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}
