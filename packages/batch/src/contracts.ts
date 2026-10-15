/** Batch-owned contracts. Runtime adapters must enforce authority, not trust a model's claims. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Input = { name: string; digest: string; size: number; artifact: string }
export type Spec = {
  prompt: string
  budget: number
  itemBudget: number
  itemTimeoutMs: number
  concurrency: number
  maxRepairs: number
  failureLimit: number
  schema?: Json
}
export type ItemState = 'pending' | 'accepted' | 'done' | 'invalid' | 'failed' | 'cancelled' | 'unknown'
export type Attempt = {
  key: string
  number: number
  ceiling: number
  deadline: number
  charged: number
  status: 'outbox' | 'running' | 'terminal' | 'unknown'
  binding?: { job: string; session: string; frame: string }
}
export type Item = {
  ordinal: number
  input: Input
  state: ItemState
  attempts: Attempt[]
  output?: Json
  error?: string
  child?: string
  session?: string
}
export type Manifest = {
  version: 1
  id: string
  spec: Spec
  digest: string
  created: number
  status: 'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'failed' | 'unknown'
  total: number
  next: number
  settled: number
  successes: number
  failures: number
  spent: number
  reserved: number
  uncertain: number
  active: number[]
  resultBytes: number
  stop?: 'cancelled' | 'budget_exhausted' | 'failed'
}
export type Stored = { value: Json; revision: string }
/** Structural adapter for the generic owner store; no SQL, paths or caller-supplied owner. */
export interface StoreTransaction {
  get(key: string): Stored | undefined
  put(key: string, value: Json, expectedRevision: string | null): void
}
export interface Store {
  scan(input: { prefix: string; limit: number; cursor?: string }): Promise<{
    rows: readonly Stored[]
    nextCursor?: string
  }>
  transaction<T>(fn: (tx: StoreTransaction) => T): Promise<T>
}
export type Dispatch = {
  key: string
  batch: string
  ordinal: number
  attempt: number
  input: Input
  prompt: string
  ceiling: number
  deadline: number
  /** Repairs must continue the exact child, without widening input authority. */
  child?: string
}
export type Receipt = {
  key: string
  inputDigest: string
  child: string
  job: string
  session: string
  frame: string
  /** Authoritative cumulative cost for this attempt, including interrupted work. */
  charged: number
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  text?: string
  inputRead?: boolean
}
export interface Executor {
  /** Host-verified capability; an arbitrary plugin/provider's assertion is insufficient. */
  readonly authority: {
    immutableInputOnly: boolean
    durableIdempotency: boolean
    hardBudget: boolean
    terminalBilling: boolean
    bindingReceipts: boolean
  }
  /** Absent is proven never accepted; an unprovable outcome must return unknown. */
  lookup(key: string): Promise<Receipt | undefined>
  /** Same key + same payload returns the original job; changed payload is refused. */
  dispatch(input: Dispatch): Promise<Receipt>
  /** Durably fences this key against any later dispatch, including when absent.
   * Returns authoritative current billing; undefined means proven never accepted and fenced. */
  cancel(key: string): Promise<Receipt | undefined>
}
export class BatchError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message)
    this.name = 'BatchError'
  }
}
