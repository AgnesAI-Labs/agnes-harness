import type {
  ComparisonAcceptance,
  ComparisonCreateParams,
  ComparisonLane,
  ComparisonPreparedReceipt,
  ComparisonRound,
  ComparisonSubmitParams,
} from '@agnes/protocol'

export type Side = 'left' | 'right'
export const SIDES: readonly Side[] = ['left', 'right']
export type TerminalCause = ComparisonRound['terminalCauses'][number]['cause']
export type SafeError = { code: string; message: string }
export type Receipt =
  | { status: 'accepted'; seq: number }
  | { status: 'rejected'; error: SafeError }
  | { status: 'unknown'; error?: SafeError }
export interface WorkspaceBaseline {
  id: string
  digest: string
  policyHash: string
  roots: Record<Side, string>
  labels: Record<Side, string>
}
export interface WorkspaceSnapshotPort {
  /** Freeze once, then materialize two independent authorized roots; clean partial failure before rejecting. */
  prepare(input: { comparisonId: string; cwd: string }): Promise<WorkspaceBaseline>
  /** Idempotent. Only called after both session owners confirm exit. Never delete the source workspace. */
  release(comparisonId: string): Promise<void>
}
export interface SessionObservation {
  phase: ComparisonLane['phase']
  lastSeq: number
  /** Waiting, parked and recovering are not terminal even if this run invocation returned. */
  settled: boolean
  /** New adapters supply durable terminal evidence; omission is legacy and always projects unknown. */
  terminalCause?: TerminalCause
}
export interface SessionPort {
  /** New adapters reserve both actual configuration owners before the root CAS. */
  admit?(input: {
    comparisonId: string
    inputId: string
    content: ComparisonSubmitParams['content']
    lanes: Record<Side, ComparisonLane>
    prepared: Partial<Record<Side, ComparisonPreparedReceipt>>
    permissionMode: NonNullable<ComparisonSubmitParams['permissionMode']>
  }): Promise<{
    prepared?: Partial<Record<Side, ComparisonPreparedReceipt>>
    enqueue(side: Side): Promise<Receipt>
    ready(): Promise<void>
    run(side: Side): Promise<SessionObservation>
    /** May only release reservations with no queued/unfinished input. */
    release(): Promise<void>
  }>
  /** Reserve allocation by comparison+side before creation; close must find it even if this reply is lost. */
  create(input: {
    comparisonId: string
    side: Side
    cwd: string
    runtime: string
    preset?: ComparisonCreateParams['preset']
    model?: ComparisonCreateParams['model']
  }): Promise<ComparisonLane & { prepared?: ComparisonPreparedReceipt }>
  /** Must not execute the input. Persist an inputId+payload receipt in this session's ledger. */
  enqueue(input: {
    comparisonId: string
    side: Side
    sessionId: string
    inputId: string
    content: ComparisonSubmitParams['content']
  }): Promise<Receipt>
  /** One invocation, no transport retry. Must honor the input cancellation fence. */
  run(input: { sessionId: string; inputId: string }): Promise<SessionObservation>
  /** Fence this input before aborting active work, so a late run invocation cannot restart it. */
  cancel(input: {
    sessionId: string
    inputId?: string
    exactInput?: boolean
  }): Promise<SessionObservation | void>
  close(input: { comparisonId: string; side: Side }): Promise<{ exited: boolean }>
  /** Read ledger only: no reopen, resume, enqueue or run. Receipt must match exactly this inputId. */
  inspect(input: {
    sessionId: string
    inputId: string
  }): Promise<{ receipt?: Receipt; state?: SessionObservation; cancellation?: 'acknowledged' }>
}
export type RunStatus = 'reserved' | 'running' | 'waiting' | 'settled' | 'unknown' | 'skipped'
/** Wall start plus optional confirmed elapsed. Absence is a legacy run, not zero duration. */
export interface RunTiming {
  startedAt: string
  finishedAt: string | null
  elapsedMs: number | null
  terminalConfirmed: boolean
}
export interface RunRecord {
  status: RunStatus
  error?: SafeError
  /** Present only for a terminal settlement. Legacy records may omit it and project as unknown. */
  terminalCause?: TerminalCause
  /** Present only after a clocked running reservation. Reconcile must not invent it. */
  timing?: RunTiming
  /** Session seq of the settled observation. Summary can reject a cut that has not reached it. */
  terminalSeq?: number
}
/** now is epoch milliseconds; monotonic is only comparable with itself. */
export interface ComparisonClock {
  now(): number
  monotonic(): number
}
export interface RoundRecord {
  inputId: string
  payload: string
  permissionMode?: NonNullable<ComparisonSubmitParams['permissionMode']>
  prepared?: Partial<Record<Side, ComparisonPreparedReceipt>>
  acceptances: Record<Side, ComparisonAcceptance>
  runs: Record<Side, RunRecord>
}
export interface ComparisonRecord {
  id: string
  revision: number
  createPayload: string
  creation: 'preparing' | 'ready' | 'failed'
  permissionMode?: NonNullable<ComparisonCreateParams['permissionMode']>
  /** Monotonic storage retirement. Absence is legacy full storage, never evidence of a fence. */
  retirement?: {
    state: 'full' | 'releasing' | 'released' | 'removing' | 'removed'
    /** Revision that permanently closed admission; retained across retries and removal. */
    epoch: number
  }
  /** Frozen once after reserving the original request identity, before preparing either lane. */
  selection?: { preset: string; model: NonNullable<ComparisonCreateParams['model']> }
  /** Frozen producer evidence, never reconstructed from a later profile or selection request. */
  prepared?: Partial<Record<Side, ComparisonPreparedReceipt>>
  baseline?: WorkspaceBaseline
  lanes: Partial<Record<Side, ComparisonLane>>
  rounds: RoundRecord[]
  cancellation: Partial<Record<Side, 'requested' | 'acknowledged' | 'unknown'>>
  /** Permanent input fence; cleanup acknowledgement is separate from execution admission. */
  inputCancellations?: Array<{
    inputId: string
    sides: Partial<Record<Side, 'requested' | 'acknowledged' | 'unknown'>>
  }>
  cleanup: { exited: Side[]; released: boolean }
  error?: SafeError
}

export function comparisonInputCancelled(record: ComparisonRecord, inputId: string, side?: Side): boolean {
  const cancellation = record.inputCancellations?.find((value) => value.inputId === inputId)?.sides
  return side === undefined
    ? SIDES.some((value) => comparisonInputCancelled(record, inputId, value))
    : cancellation?.[side] !== undefined ||
        (record.rounds.at(-1)?.inputId === inputId && record.cancellation[side] !== undefined)
}
export interface ComparisonStore {
  /** Returned records are detached snapshots. IDs are opaque: never interpolate them into file paths. */
  read(id: string): Promise<ComparisonRecord | undefined>
  /** Atomic durable CAS: null means absent; next.revision is 0 or expectedRevision+1. */
  compareAndSwap(id: string, expectedRevision: number | null, next: ComparisonRecord): Promise<boolean>
}
export interface ComparisonPorts {
  store: ComparisonStore
  workspaces: WorkspaceSnapshotPort
  sessions: SessionPort
  /** Resolve defaults once; retries of an existing request never invoke this port. */
  resolveCreation?(input: ComparisonCreateParams): Promise<NonNullable<ComparisonRecord['selection']>>
  /** Optional. Production uses Date.now and performance.now. Tests without it keep legacy runs. */
  clock?: ComparisonClock
}
