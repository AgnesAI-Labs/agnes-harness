/** Batch-owned contracts. Runtime adapters must enforce authority, not trust a model's claims. */
import type { AttachmentScope, ManagedOwnedStore, OwnedStoreTxn } from '@agnes/extension-api'
import type { ArtifactRef, JsonValue as Json } from '@agnes/protocol'

export type { JsonValue as Json } from '@agnes/protocol'
export type InputReference = {
  artifact?: ArtifactRef
  receipt?: { id: string; scope: AttachmentScope }
  /** Immutable original copied under the managed service's private area, never an attachment read lease. */
  workspace?: string
  path?: string
  skip?: 'unsupported_type' | 'too_large'
}
export type Input = InputReference & { name: string; digest: string; size: number }
export type Spec = {
  prompt: string
  budget: number
  itemBudget: number
  itemTimeoutMs: number
  concurrency: number
  maxRepairs: number
  failureLimit: number
  maxEdge?: number
  out?: string
  schema?: Json
}
export type ItemState =
  | 'pending'
  | 'accepted'
  | 'done'
  | 'invalid'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'skipped'
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
  invalid: number
  failed: number
  cancelled: number
  skipped: number
  spent: number
  reserved: number
  uncertain: number
  active: number[]
  resultBytes: number
  stop?: 'cancelled' | 'budget_exhausted' | 'failed'
}
/** Real managed-service store, bound by the runtime to this installation/profile/service. */
export type Store = ManagedOwnedStore
export type StoreTransaction = OwnedStoreTxn
export type Stored = NonNullable<ReturnType<OwnedStoreTxn['get']>>
export type Dispatch = {
  operationId: string
  key: string
  batch: string
  ordinal: number
  attempt: number
  input: Input
  prompt: string
  ceiling: number
  deadline: number
  maxEdge?: number
  /** Repairs must continue the exact child, without widening input authority. */
  child?: string
}
export type Receipt = {
  key: string
  inputDigest: string
  child: string
  job: string
  session: string
  lane: string
  frame: string
  /** Authoritative cumulative cost for this attempt, including interrupted work. */
  charged: number
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  text?: string
  inputRead?: boolean
}
export interface Executor {
  /** Public ordinary-session connector, with durable prompt credit ceilings. */
  readonly sessionBacked?: true
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
