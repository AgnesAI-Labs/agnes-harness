import type { ChildExecutionState } from '@agnes/extension-api'

export type {
  BeginChildAttemptInput,
  BudgetScopeRecord,
  CancelCreatingChildInput,
  CancelledChildFact,
  ChildCreationCasInput,
  ChildCreationPhase,
  ChildExecutionState,
  ChildKind,
  ChildTaskRecord,
  CostOriginBinding,
  CreateDelegatedChildInput,
  CreateDelegatedChildResult,
  DeferCreatingChildInput,
  DeferredChildFact,
  PlannedWorkspace,
  ReleaseRequest,
  ReservationRecord,
  ReserveRequest,
  ReserveResult,
  SettleRequest,
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

/** First-release fence: cancelled/cancelling cannot return to execution. */
export function canTransitionChildState(from: ChildExecutionState, to: ChildExecutionState): boolean {
  if (from === to) return true
  if (from === 'cancelled' || from === 'failed' || from === 'completed') return false
  if (from === 'cancelling') return to === 'cancelled' || to === 'failed'
  if (to === 'running') return from === 'ready' || from === 'waiting_approval' || from === 'creating'
  return true
}

export function isTerminalChildState(state: ChildExecutionState): boolean {
  return TERMINAL.has(state)
}
