import type { EventEnvelope } from '@agnes/protocol'

export type Seq = number
export type SessionKey = string
export type Lane = string

/** A ledger row exactly as it is stored: seq / ts / id are already assigned. */
export type Event = EventEnvelope
/**
 * What a caller hands to `append`. `seq` is assigned by storage inside the commit transaction,
 * while `ts` and `id` are minted by core unless the caller supplies them (replay and import paths
 * carry their own).
 */
export type EventInput = Omit<EventEnvelope, 'seq' | 'ts' | 'id'> & { ts?: string; id?: string }
/**
 * A validated row on its way to storage: everything an `Event` has except the sequence, which the
 * commit transaction is the sole authority for. Carrying a placeholder `seq` here would put a value
 * in a field typed as the stored one, and the first rule that relates `seq` to a sibling field
 * would read the placeholder instead of the sequence the row was actually written at.
 */
export type PreparedEvent = Omit<Event, 'seq'>

export type CoreErrorCode =
  | 'E_ENVELOPE'
  | 'E_UNKNOWN_EVENT'
  | 'E_SURFACE_RANGE'
  | 'E_WRITER_LEASE'
  | 'E_CLOSED'
  | 'E_STORAGE_FAULT'
  | 'E_WORKSPACE_CLOSED'
  | 'E_LEDGER_INTEGRITY'
  | 'E_EXECUTE_PERMIT'
  | 'E_LANE_BUSY'
  | 'E_REGISTRY_DUPLICATE'
  | 'E_TOOLDEF_META'
  | 'E_SEAM_MISSING'
  | 'E_FS_UNENFORCED'
  | 'E_FS_POLICY_INVALID'
  | 'E_REQUEST_FROZEN'
  | 'E_RELATION'
  | 'E_CAS'
  | 'E_SCAN_UNBOUNDED'
  | 'E_SCAN_TRUNCATED'
  | 'E_DEPTH_EXCEEDED'
  | 'E_NONCE'
  | 'E_REQUEST_KIND'
  | 'E_MODEL_UNKNOWN'
  | 'E_CHILD_LIMIT'
  | 'E_BUDGET'
  | 'E_CHILD_NOT_FOUND'
  | 'E_UNSUPPORTED'
  | 'E_CHILD_CONFLICT'
  | 'E_FORMAT'

/**
 * Every failure core raises carries a machine-readable `code`; the human message is prefixed with
 * it so a bare `err.message` in a log still says which rule fired. `detail` carries the operands
 * the caller needs to act on (which register, which lease, which validation errors).
 */
export class CoreError extends Error {
  constructor(
    readonly code: CoreErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`)
    this.name = 'CoreError'
  }
}

export type Disposer = () => void
export type Clock = () => number

export interface IdMinter {
  ulid(): string
  effectId(): string
  toolUseId(ordinal: number): string
  requestId(): string
  nonce(): string
}
