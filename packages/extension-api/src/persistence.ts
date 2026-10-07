/**
 * Session persistence provider.
 *
 * The methods are the ones Core's log storage and the host package-table store already share:
 * append (`commit`), paged `scan`, the single-writer lease (`open` / `renew` / `release`), and
 * `tables`. Field names match those internal contracts. A provider does not migrate another
 * provider's files. Selecting a different id applies on the next process start.
 */

/** Built-in provider id. Host uses it when config omits `persistence.provider`. */
export const DEFAULT_PERSISTENCE_PROVIDER_ID = 'sqlite'

/**
 * Plugin state for every persistence provider. Changing the selected provider does not affect
 * the running process.
 */
export const PERSISTENCE_EFFECT = 'restart-required' as const

/** Same page cap as Core `SCAN_PAGE_MAX`. A larger request is a full read, not a silent cut. */
export const PERSISTENCE_SCAN_PAGE_MAX = 500

const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,63}$/

export interface PersistenceProviderState {
  readonly effect: typeof PERSISTENCE_EFFECT
}

/** One ledger row. `seq` is assigned by the provider inside `commit`. */
export interface PersistenceEventRecord {
  seq?: number
  ts: string
  id: string
  type: string
  lane?: string
  v?: number
  actor?: unknown
  origin?: string
  trust?: string
  data: unknown
  register?: string
  ignorable?: boolean
  surfaceOp?: unknown
  sourceEventSeqs?: unknown
}

export interface PersistenceScanQuery {
  fromSeq?: number
  toSeq?: number
  type?: string | readonly string[]
  lane?: string
  order?: 'asc' | 'desc'
  limit?: number
}

/** Renew-on-write. A lapsed lease is taken back only when the log is still at `expectedLastSeq`. */
export interface PersistenceLeaseClaim {
  ttlMs: number
  expectedLastSeq: number
}

export interface PersistenceCommit {
  events: readonly PersistenceEventRecord[]
  expectedWriterRunId: string
  integrity?: readonly PersistenceIntegrityCommit[]
  expectedRegisterSeq?: { register: string; key: string; seq: number | null }
  claim?: PersistenceLeaseClaim
  /** Program-counter cell, written in the same commit at the batch's last seq. */
  opState?: { lane: string; data: unknown }
}

export interface PersistenceIntegrityCommit {
  seq: number
  mode: 'anchor' | 'chain'
  previousDigest: string | null
  digest: string
}

export interface PersistenceCommitReceipt {
  firstSeq: number
  seqs: number[]
  opState?: { seq: number }
}

export interface PersistenceOpenResult {
  lastSeq: number
  formatVersion: number
  created?: boolean
  parent?: { key: string; boundarySeq: number }
}

export interface PersistenceRegisterRow {
  register: string
  key: string
  seq: number
  data: unknown
}

export interface PersistenceIntegrityRow {
  sessionKey: string
  event: PersistenceEventRecord
  integrity: {
    mode: 'anchor' | 'chain'
    previousDigest: string | null
    digest: string
  } | null
}

/** The host package-table handle: one owner's statements, not a second connection to the ledger. */
export interface PersistenceTableHandle {
  name: string
  exec(sql: string): void
  run(sql: string, params?: readonly unknown[]): { changes: number }
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined
  transaction<T>(fn: () => T): T
}

export interface PersistenceTableStore {
  table(name: string): PersistenceTableHandle
}

export interface PersistenceSessionStore {
  open(key: string, claim: { writerRunId: string; ttlMs: number }): Promise<PersistenceOpenResult>
  commit(key: string, tx: PersistenceCommit): Promise<PersistenceCommitReceipt>
  renew(key: string, writerRunId: string, claim?: PersistenceLeaseClaim): Promise<void>
  release(key: string, writerRunId: string): Promise<void>
  scan(key: string, query: PersistenceScanQuery): Promise<PersistenceEventRecord[]>
  registers(key: string): Promise<PersistenceRegisterRow[]>
  tables(owner: string): PersistenceTableStore
  close(): Promise<void>
  scanIntegrity?(
    key: string,
    query: { fromSeq: number; toSeq: number; limit: number },
  ): Promise<PersistenceIntegrityRow[]>
  createChild?(parentKey: string, boundarySeq: number, childKey: string): Promise<void>
  discardNewSession?(key: string, expectedWriterRunId: string, claim?: PersistenceLeaseClaim): Promise<void>
}

export interface PersistenceOpenOptions {
  /** Directory the provider may use for its files. */
  dataDir: string
  clock?: () => number
}

export interface PersistenceProvider {
  readonly id: string
  readonly version: string
  readonly state: PersistenceProviderState
  open(options: PersistenceOpenOptions): PersistenceSessionStore | Promise<PersistenceSessionStore>
}

export interface PersistenceCatalogEntry {
  readonly id: string
  readonly version: string
  readonly state: PersistenceProviderState
}

/**
 * The key half of a register cell. Same spelling as Core `registerKey`: most registers are keyed
 * by lane, artifact jobs by `jobId`, and harness entries by kind and id joined with NUL.
 */
export function persistenceRegisterKey(event: {
  register?: string
  lane?: string
  data: unknown
}): string {
  const data = event.data as Record<string, unknown> | null
  switch (event.register) {
    case 'artifact/job':
      return String(data?.jobId ?? '')
    case 'harness/entry':
      return `${String(data?.kind ?? '')}\u0000${String(data?.id ?? '')}`
    default:
      return event.lane ?? 'main'
  }
}

/** Whether a register write erases its cell. Same rule as Core `isRegisterTombstone`. */
export function isPersistenceTombstone(register: string, data: unknown): boolean {
  if (data === null) return true
  return (
    register === 'harness/entry' &&
    typeof data === 'object' &&
    data !== null &&
    (data as { tombstone?: unknown }).tombstone === true
  )
}

/** Checks the provider shape. A provider that does not declare restart-required is refused. */
export function definePersistenceProvider<T extends PersistenceProvider>(provider: T): T {
  if (provider === null || typeof provider !== 'object') throw new Error('persistence provider must be an object')
  if (typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id))
    throw new Error('persistence provider id must match ^[a-z][a-z0-9._-]{0,63}$')
  if (typeof provider.version !== 'string' || provider.version.length === 0 || provider.version.length > 64)
    throw new Error('persistence provider version must be a non-empty string')
  if (provider.state?.effect !== PERSISTENCE_EFFECT)
    throw new Error('persistence provider changes are restart-required')
  if (typeof provider.open !== 'function') throw new Error('persistence provider open must be a function')
  return provider
}
