import type { ChildExecutionState } from '@agnes/extension-api'

export type {
  AppendChildEventInput,
  AppendChildEventResult,
  BeginChildAttemptInput,
  BudgetScopeRecord,
  CancelCreatingChildInput,
  CancelledChildFact,
  ChildCheckpointRecord,
  ChildCreationCasInput,
  ChildCreationPhase,
  ChildEventEnvelope,
  ChildEventKind,
  ChildEventReplayResult,
  ChildExecutionState,
  ChildKind,
  ChildLeaseRecord,
  ChildTaskRecord,
  CostOriginBinding,
  CreateDelegatedChildInput,
  CreateDelegatedChildResult,
  DeferCreatingChildInput,
  DeferredChildFact,
  NonInterruptibleStopReceipt,
  PlannedWorkspace,
  RecapFactSnapshot,
  ReleaseRequest,
  ReservationRecord,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
  SubtaskArtifactRef,
  SubtaskFactRecord,
  TreeUsage,
} from '@agnes/extension-api'

/** Data-domain version written with child identity and budget rows. */
export const CHILD_CONTROL_FORMAT = 4

export const ACTIVE_CHILD_STATES = [
  'creating',
  'ready',
  'running',
  'waiting_approval',
  'recovery_pending',
  'cancelling',
] as const

export function isActiveChildState(state: ChildExecutionState): boolean {
  return (ACTIVE_CHILD_STATES as readonly string[]).includes(state)
}

const TERMINAL = new Set<ChildExecutionState>(['completed', 'failed', 'cancelled'])

/** First-release fence: terminal states never regress, and cancelled/cancelling cannot return to execution. */
export function canTransitionChildState(from: ChildExecutionState, to: ChildExecutionState): boolean {
  if (from === to) return true
  if (from === 'cancelled' || from === 'failed' || from === 'completed') return false
  if (from === 'cancelling') return to === 'cancelled' || to === 'failed'
  if (to === 'running')
    return (
      from === 'ready' ||
      from === 'idle' ||
      from === 'paused' ||
      from === 'disconnected' ||
      from === 'interrupted' ||
      from === 'waiting_approval' ||
      from === 'creating' ||
      from === 'recovery_pending'
    )
  return true
}

export function isTerminalChildState(state: ChildExecutionState): boolean {
  return TERMINAL.has(state)
}
