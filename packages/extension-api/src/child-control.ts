import type { Seq, SessionKey } from './common.js'

/** Durable child identity, workspace and budget contracts for persistence providers. */
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

export type ChildExecutionState =
  | 'creating'
  | 'ready'
  | 'running'
  | 'waiting_approval'
  | 'recovery_pending'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'

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
  capMicro: bigint
  settledMicro: bigint
  heldMicro: bigint
}

export type ReservationRecord = {
  permitId: string
  rootTaskId: string
  scopeIds: string[]
  qMicro: bigint
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
  treeCapMicro: bigint
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
  rootTaskId: string
  scopeIds: string[]
  qMicro: bigint
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
  settledMicro: bigint
  heldMicro: bigint
  capMicro: bigint
  unknownHeld: boolean
}

export interface ChildControlStore {
  childControlFormat(): number
  assertWritableFormat(): void
  createDelegatedChild(input: CreateDelegatedChildInput): Promise<CreateDelegatedChildResult>
  lookupByKey(childKey: SessionKey): Promise<ChildTaskRecord | null>
  lookupByCreationId(creationId: string): Promise<ChildTaskRecord | null>
  listByParent(parentKey: SessionKey): Promise<ChildTaskRecord[]>
  listByRoot(rootTaskId: string): Promise<ChildTaskRecord[]>
  listCreatingChildAttempts(): Promise<ChildTaskRecord[]>
  beginChildAttempt(input: BeginChildAttemptInput): Promise<ChildTaskRecord | null>
  deferCreatingChild(input: DeferCreatingChildInput): Promise<DeferredChildFact>
  commitCreatingChild(input: ChildCreationCasInput): Promise<boolean>
  /**
   * Cancels the creation attempt and, in the same write, moves a child still in `creating` out of
   * the active set: `failed` for an open that failed, `cancelled` otherwise. It never ran.
   */
  cancelCreatingChild(input: CancelCreatingChildInput): Promise<CancelledChildFact>
  casState(childKey: SessionKey, expectedRevision: number, next: ChildTaskRecord['state']): Promise<boolean>
  nextOrdinal(parentKey: SessionKey, effectId: string): Promise<number>
  existsSession(key: SessionKey): Promise<boolean>
  ensureRootScope(rootTaskId: string, capMicro: bigint): Promise<BudgetScopeRecord>
  scopeForChild(childKey: SessionKey): Promise<BudgetScopeRecord | null>
  reserve(req: ReserveRequest): Promise<ReserveResult>
  settleOrigin(req: SettleRequest): Promise<void>
  releaseReservation(request: string | ReleaseRequest): Promise<void>
  projectTree(rootTaskId: string): Promise<TreeUsage | null>
  workspace(workspaceId: string): Promise<PlannedWorkspace | null>
  updateWorkspace?(
    workspaceId: string,
    patch: Partial<Pick<PlannedWorkspace, 'phase' | 'path' | 'root' | 'branch'>>,
  ): Promise<void>
  lookupWorkspaceByPath?(path: string): Promise<PlannedWorkspace | null>
  bumpWriterGeneration?(key: SessionKey): Promise<number>
  takeoverReservation?(permitId: string, expectedWriterGeneration: number): Promise<ReservationRecord>
  writerGeneration?(key: SessionKey): Promise<number>
  peekReservation?(permitId: string): Promise<ReservationRecord | null>
  lookupReservationByIdentity?(
    rootTaskId: string,
    effectId: string,
    requestHash: string,
  ): Promise<ReservationRecord | null>
  clearWriterLease?(key: SessionKey): Promise<void>
}
