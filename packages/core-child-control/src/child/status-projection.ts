import type { ChildAgentStatus, ChildExecutionState, ChildTaskRecord } from '@agnes/extension-api'

export type ProjectedChildStatus = Readonly<{
  status: ChildAgentStatus
  executionState: ChildExecutionState
  cancelling: boolean
}>

/**
 * Single authoritative mapping from durable `ChildExecutionState` (+ live hints) to the
 * UI / external `ChildAgentStatus`. Preserves `executionState` alongside `status` so callers
 * and UI never diverge on pending (`creating`/`ready`), `waiting_approval`, `paused` or
 * `disconnected` states.
 */
export function projectChildStatus(
  record: Pick<ChildTaskRecord, 'state'>,
  live?: Readonly<{
    humanStopped?: boolean
    residentIdle?: boolean
  }>,
): ProjectedChildStatus {
  const executionState = record.state
  if (executionState === 'completed' || executionState === 'failed' || executionState === 'cancelled') {
    return { status: executionState, executionState, cancelling: false }
  }
  if (live?.humanStopped || executionState === 'interrupted') {
    return { status: 'interrupted', executionState, cancelling: false }
  }
  switch (executionState) {
    case 'creating':
    case 'ready':
      return { status: 'starting', executionState, cancelling: false }
    case 'waiting_approval':
      return { status: 'waiting_approval', executionState, cancelling: false }
    case 'paused':
      return { status: 'paused', executionState, cancelling: false }
    case 'disconnected':
      return { status: 'disconnected', executionState, cancelling: false }
    case 'idle':
      return { status: 'idle', executionState, cancelling: false }
    case 'cancelling':
      return { status: 'running', executionState, cancelling: true }
    case 'running':
    case 'recovery_pending':
      return {
        status: live?.residentIdle ? 'idle' : 'running',
        executionState,
        cancelling: false,
      }
  }
}

/**
 * Monotonic terminal precedence: a recorded `failed` outcome is never rewritten to `cancelled`
 * or `completed` by a subsequent teardown or cancel request.
 */
export function resolveTerminalChildState(
  current: ChildExecutionState,
  requested: 'completed' | 'failed' | 'cancelled',
): 'completed' | 'failed' | 'cancelled' {
  if (current === 'failed') return 'failed'
  if (current === 'completed') return 'completed'
  if (current === 'cancelled') return 'cancelled'
  return requested
}
