import type { SessionImpl, TurnMemory } from '../../step/session.js'
import { turnTimeLimit } from '../../step/time-limit.js'

/** What a call's timeout leaves before the turn's deadline, so a result can still reach the model. */
const DEADLINE_MARGIN_MS = 5_000
/** The shortest timeout a call is told near the deadline, so a quick check can still run. */
const DEADLINE_FLOOR_MS = 1_000

/**
 * The limits a tool call is handed: its own timeout, the preset's default timeout and output cap,
 * and the turn's wall-clock limit when the prompt set one, so a tool that waits (a foreground
 * command) can stop short of the turn's deadline. In such a turn the timeout itself is also cut to
 * the time left less a small margin, so a tool that only honours its timeout cannot wait past the
 * deadline either; tools that read the limit (the shell) leave a wider margin of their own.
 */
export function toolCallLimits(s: SessionImpl, t: TurnMemory | null, timeoutMs: number) {
  const limit = turnTimeLimit(t)
  return {
    timeoutMs: limit
      ? Math.min(timeoutMs, Math.max(DEADLINE_FLOOR_MS, limit.deadlineAt - s.d.clock() - DEADLINE_MARGIN_MS))
      : timeoutMs,
    defaultTimeoutMs: s.preset.tools.timeoutMs,
    outputMaxBytes: s.preset.tools.outputMaxBytes,
    ...(limit ? { turnTimeLimit: limit } : {}),
  }
}
