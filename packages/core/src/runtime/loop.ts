import type {
  Actor,
  JsonValue,
  RuntimeIdentity,
  RuntimeTurnOptions,
  SessionRuntimeControlParams,
  SessionRuntimeControlResult,
  SessionRuntimeState,
} from '@agnes/protocol'

/** Runtime-neutral operation routed to the existing session writer with a server-derived actor. */
export type RuntimeControl = Omit<SessionRuntimeControlParams, 'sessionId'> & { actor: Actor }

import type { AbortResult } from '../step/control.js'
import type { ResumeMode, ResumeReport } from '../step/resume.js'
import type { StepOutcome, TurnOutcome } from '../step/session.js'

/**
 * The execution owner fitted by Host assembly. The session retains shared ledger, workspace,
 * approval and presentation services; this port exclusively owns scheduling and recovery.
 * Implementations receive capability-scoped adapters from Host, never a Kernel or Cordis context.
 */
export interface SessionLoop {
  readonly identity: RuntimeIdentity
  /** Validate and freeze runtime-specific input metadata before the durable inbox append. */
  prepareInput?(target: 'next-turn' | 'next-step', options?: RuntimeTurnOptions): JsonValue | undefined
  state(): SessionRuntimeState
  control?(input: RuntimeControl): Promise<Omit<SessionRuntimeControlResult, 'runtime'>>
  resume(options: { mode?: ResumeMode }): Promise<ResumeReport>
  run(options: { until: 'turn-end' | 'idle'; signal: AbortSignal }): Promise<TurnOutcome>
  step(): Promise<StepOutcome>
  abort(by: Actor): Promise<AbortResult>
  /** Cancel and drain before the session releases its writer or workspace. */
  close(): Promise<void>
}

export { NATIVE_RUNTIME } from '@agnes/runtime-api'
