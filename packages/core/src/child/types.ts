import type { RuntimeIdentity } from '@agnes/protocol'
import type { Seq, SessionKey } from '../types.js'

/** Data-domain version written with child identity and budget rows. */
export const CHILD_CONTROL_FORMAT = 5

export type ChildCreationPhase = 'creating' | 'deferred' | 'committed' | 'cancelled'

export type DeferredChildFact = Readonly<{
  childKey: SessionKey
  creationId: string
  attemptId: string
  revision: number
  deferredAt: number
}>

export type CancelledChildFact = Readonly<{
  childKey: SessionKey
  creationId: string
  attemptId: string
  revision: number
  reason: 'workspace_closed' | 'open_failed'
  cancelledAt: number
}>

export const ACTIVE_CHILD_STATES = [
  'creating',
  'ready',
  'running',
  'waiting_approval',
  'recovery_pending',
  'cancelling',
] as const

export type ChildExecutionState =
  | (typeof ACTIVE_CHILD_STATES)[number]
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ChildKind = 'fork' | 'spawn'

export type ChildTaskRecord = {
  childKey: SessionKey
  creationId: string
  attemptId: string
  creationPhase: ChildCreationPhase
  creationRevision: number
  attemptStartedAt: number
  deferredFact?: DeferredChildFact
  cancelledFact?: CancelledChildFact
  parentKey: SessionKey
  rootTaskId: string
  runtimeOwnerSessionKey: SessionKey
  kind: ChildKind
  /** Absent on legacy Native records; never infer another runtime from current configuration. */
  runtime?: RuntimeIdentity
  seedMode?: 'fresh' | 'history'
  model?: { route: string; model: string }
  /** Immutable requested cwd; cwd may later become the allocated worktree path. */
  creationCwd?: string
  generationDepth: number
  generationLimit: number
  boundarySeq: Seq
  inputHash: string
  inputText: string
  cwd: string
  actorId: string
  budgetScopeId: string
  ancestorScopeIds: string[]
  workspaceId: string | null
  isolation: 'worktree' | 'shared'
  state: ChildExecutionState
  stateRevision: number
  controlFormat: number
}

export type BudgetScopeRecord = {
  scopeId: string
  rootTaskId: string
  childKey: SessionKey | null
  parentScopeId: string | null
  /** null is an explicit unlimited scope, never a numeric sentinel. */
  capMicro: bigint | null
  settledMicro: bigint
  heldMicro: bigint
}

export type ReservationRecord = {
  permitId: string
  rootTaskId: string
  scopeIds: string[]
  /** null preserves an unknown quotation; allowed only under unlimited scopes. */
  qMicro: bigint | null
  effectId: string
  requestHash: string
  writerGeneration: number
  status: 'held' | 'settled' | 'released' | 'unknown'
}

export type PlannedWorkspace = {
  workspaceId: string
  childKey: SessionKey
  isolation: 'worktree' | 'shared'
  path: string
  root?: string
  branch?: string
  phase:
    | 'planned'
    | 'preparing'
    | 'attached'
    | 'cleanup_eligible'
    | 'inspecting'
    | 'worktree_removed'
    | 'branch_removed'
    | 'kept_dirty'
    | 'kept_unmerged'
    | 'inspection_failed'
    | 'cleanup_failed'
}

export type CreateDelegatedChildInput = {
  childKey: SessionKey
  parentKey: SessionKey
  boundarySeq: Seq
  creationId: string
  attemptId?: string
  attemptStartedAt?: number
  kind: ChildKind
  /** Absent on legacy Native records; never infer another runtime from current configuration. */
  runtime?: RuntimeIdentity
  seedMode?: 'fresh' | 'history'
  model?: { route: string; model: string }
  /** Immutable requested cwd; cwd may later become the allocated worktree path. */
  creationCwd?: string
  rootTaskId: string
  runtimeOwnerSessionKey: SessionKey
  generationDepth: number
  generationLimit: number
  maxFanOut: number
  inputHash: string
  inputText: string
  cwd: string
  actorId: string
  isolation: 'worktree' | 'shared'
  workspaceId: string
  treeCapMicro: bigint | null
  childCapMicro: bigint | null
  writerRunId: string
}

export type BeginChildAttemptInput = Readonly<{
  childKey: SessionKey
  creationId: string
  previousAttemptId: string
  nextAttemptId: string
  expectedRevision: number
  startedAt: number
}>

export type ChildCreationCasInput = Readonly<{
  childKey: SessionKey
  creationId: string
  attemptId: string
  expectedRevision: number
}>

export type DeferCreatingChildInput = ChildCreationCasInput & Readonly<{ deferredAt: number }>

export type CancelCreatingChildInput = ChildCreationCasInput &
  Readonly<{
    reason: CancelledChildFact['reason']
    cancelledAt: number
  }>

export type CreateDelegatedChildResult =
  | { status: 'created'; record: ChildTaskRecord }
  | { status: 'existing'; record: ChildTaskRecord }
  | { status: 'conflict'; record: ChildTaskRecord }
  | {
      status: 'refused'
      reason: 'generation' | 'fan_out' | 'budget' | 'format' | 'mode'
      message: string
    }

export type ReserveRequest = {
  /** New execution callers bind admission to the real session; absent only for legacy callers. */
  originSessionKey?: SessionKey
  rootTaskId: string
  scopeIds: string[]
  /** null preserves an unknown quotation; allowed only under unlimited scopes. */
  qMicro: bigint | null
  effectId: string
  requestHash: string
  writerGeneration: number
}

export type ReserveResult =
  | { ok: true; permitId: string; status: ReservationRecord['status']; existing: boolean }
  | { ok: false; reason: 'cap' | 'unknown_bound' | 'invalid'; message: string }

export type SettleRequest = {
  permitId: string
  /** Required by explicit reservations; absent only for legacy callers during migration. */
  writerGeneration?: number
  originSessionKey: SessionKey
  originCostSeq: Seq
  actualMicro: bigint | null
  complete: boolean
  creditSource: 'gateway' | 'estimated' | 'unknown'
}

export type ReleaseRequest = { permitId: string; writerGeneration: number }

export type CostOriginBinding = {
  permitId: string
  effectId: string
  requestHash: string
  writerGeneration: number
  actualMicro: bigint | null
  scopeIds: string[]
}

export type TreeUsage = {
  /** Known monetary subtotals; unknownHeld means these are not a complete cost total. */
  settledMicro: bigint
  heldMicro: bigint
  /** null is an explicit unlimited scope, never a numeric sentinel. */
  capMicro: bigint | null
  /** Includes unknown actual spend and outstanding permits with unknown quotations. */
  unknownHeld: boolean
}

export function isActiveChildState(state: ChildExecutionState): boolean {
  return (ACTIVE_CHILD_STATES as readonly string[]).includes(state)
}

const TERMINAL = new Set<ChildExecutionState>(['completed', 'failed', 'cancelled', 'interrupted'])

/** First-release fence: cancelled/cancelling cannot return to execution. */
export function canTransitionChildState(from: ChildExecutionState, to: ChildExecutionState): boolean {
  if (from === to) return true
  if (TERMINAL.has(from)) return false
  if (from === 'cancelling') return to === 'cancelled' || to === 'failed'
  if (to === 'running') return from === 'ready' || from === 'waiting_approval' || from === 'creating'
  return true
}

export function isTerminalChildState(state: ChildExecutionState): boolean {
  return TERMINAL.has(state)
}
