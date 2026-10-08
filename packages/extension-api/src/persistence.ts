import { parseSemver } from './api-range.js'
import type { ChildControlStore } from './child-control.js'

/**
 * Session persistence provider.
 *
 * The ledger methods are the ones Core consumes:
 * append (`commit`), paged `scan`, and the single-writer lease (`open` / `renew` / `release`). Field names match those internal contracts. A provider does not migrate another
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
  /** A damaged tail was quarantined before opening this valid prefix. */
  recovery?: { diagnosticId: string; quarantineFile: string; validThroughSeq: number }
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
export interface PersistenceSqliteTableHandle {
  name: string
  exec(sql: string): void
  run(sql: string, params?: readonly unknown[]): { changes: number }
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[]
  get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined
  transaction<T>(fn: () => T): T
  /** SQLite-specific schema inventory, confined to this owner's file. */
  schema(): readonly PersistenceSqliteSchemaObject[]
}

export interface PersistenceSqliteSchemaObject {
  type: string
  name: string
  table: string
  sql: string | null
}

/** Optional synchronous SQLite port. Never imply SQL support from a ledger or KV capability. */
export interface PersistenceSqlitePort {
  readonly dialect: 'sqlite'
  tables(owner: string): PersistenceSqliteTableStore
}

/** Owner-scoped JSON values. Returned values are detached from durable state. */
export interface PersistenceMetadataNamespace {
  get(key: string): unknown | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
  entries(): readonly Readonly<{ key: string; value: unknown }>[]
  /** Synchronous atomic transaction; callbacks must not return a Promise. */
  transaction<T>(fn: () => T): T
}

export interface PersistenceMetadataPort {
  namespace(owner: string, name: string): PersistenceMetadataNamespace
}

/** Compare expired leases atomically. Keep the lease for an open op; clear it otherwise. */
export interface PersistenceReclaimPort {
  listExpired(now: number): { sessionKey: string; runId: string; until: number; generation: number }[]
  claimForReclaim(
    sessionKey: string,
    runId: string,
    until: number,
    now: number,
  ): { opState: { seq: number; data: unknown } | undefined; seq: number } | null
}

export type PersistenceChildControlPort = ChildControlStore
export type PersistenceCapability =
  | 'ledger'
  | 'metadata'
  | 'child-control'
  | 'reclaim'
  | 'integrity'
  | 'sqlite'
export interface PersistenceCapabilities {
  readonly ledger: true
  readonly metadata?: boolean
  readonly childControl?: boolean
  readonly reclaim?: boolean
  readonly integrity?: boolean
  readonly sqlite?: boolean
}

export interface PersistenceSqliteTableStore {
  table(name: string): PersistenceSqliteTableHandle
}

export interface PersistenceLedgerPort {
  open(key: string, claim: { writerRunId: string; ttlMs: number }): Promise<PersistenceOpenResult>
  commit(key: string, tx: PersistenceCommit): Promise<PersistenceCommitReceipt>
  renew(key: string, writerRunId: string, claim?: PersistenceLeaseClaim): Promise<void>
  release(key: string, writerRunId: string): Promise<void>
  scan(key: string, query: PersistenceScanQuery): Promise<PersistenceEventRecord[]>
  registers(key: string): Promise<PersistenceRegisterRow[]>
  close(): Promise<void>
  createChild?(parentKey: string, boundarySeq: number, childKey: string): Promise<void>
  discardNewSession?(key: string, expectedWriterRunId: string, claim?: PersistenceLeaseClaim): Promise<void>
}

export interface PersistenceIntegrityPort {
  scanIntegrity(
    key: string,
    query: { fromSeq: number; toSeq: number; limit: number },
  ): Promise<PersistenceIntegrityRow[]>
}

export interface PersistenceSessionStore extends PersistenceLedgerPort, Partial<PersistenceIntegrityPort> {
  /** Independent optional capabilities; absent ports are unsupported, never no-op fallbacks. */
  readonly metadata?: PersistenceMetadataPort
  readonly childControl?: PersistenceChildControlPort
  readonly reclaim?: PersistenceReclaimPort
  readonly sqlite?: PersistenceSqlitePort
}

export interface PersistenceOpenOptions {
  /** Cooperative construction cancellation; synchronous I/O cannot be interrupted mid-call. */
  signal?: AbortSignal
  /** Directory the provider may use for its files. */
  dataDir: string
  clock?: () => number
}

export interface PersistenceProvider {
  readonly id: string
  readonly version: string
  readonly state: PersistenceProviderState
  readonly capabilities: PersistenceCapabilities
  open(options: PersistenceOpenOptions): PersistenceSessionStore | Promise<PersistenceSessionStore>
}

export interface PersistenceCatalogEntry {
  readonly id: string
  readonly version: string
  readonly state: PersistenceProviderState
  readonly capabilities: PersistenceCapabilities
}

/**
 * The key half of a register cell. Same spelling as Core `registerKey`: most registers are keyed
 * by lane, artifact jobs by `jobId`, and harness entries by kind and id joined with NUL.
 */
export function persistenceRegisterKey(event: { register?: string; lane?: string; data: unknown }): string {
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
  if (provider === null || typeof provider !== 'object')
    throw new Error('persistence provider must be an object')
  if (typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id))
    throw new Error('persistence provider id must match ^[a-z][a-z0-9._-]{0,63}$')
  if (typeof provider.version !== 'string' || !parseSemver(provider.version))
    throw new Error('persistence provider version must be semver')
  if (provider.state?.effect !== PERSISTENCE_EFFECT)
    throw new Error('persistence provider changes are restart-required')
  if (
    provider.capabilities &&
    Object.values(provider.capabilities).some((value) => typeof value !== 'boolean')
  )
    throw new Error('persistence capabilities must be booleans')
  if (provider.capabilities?.ledger !== true)
    throw new Error('persistence provider must declare ledger capability')
  if (typeof provider.open !== 'function') throw new Error('persistence provider open must be a function')
  return provider
}
