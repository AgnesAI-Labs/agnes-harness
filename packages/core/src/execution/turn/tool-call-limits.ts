import type { SessionImpl, TurnMemory } from '../../step/session.js'
import { turnTimeLimit } from '../../step/time-limit.js'

/**
 * The limits a tool call is handed: its own timeout, the preset's default timeout and output cap,
 * and the turn's wall-clock limit when the prompt set one, so a tool that waits (a foreground
 * command) can stop short of the turn's deadline.
 */
export function toolCallLimits(s: SessionImpl, t: TurnMemory | null, timeoutMs: number) {
  const limit = turnTimeLimit(t)
  return {
    timeoutMs,
    defaultTimeoutMs: s.preset.tools.timeoutMs,
    outputMaxBytes: s.preset.tools.outputMaxBytes,
    ...(limit ? { turnTimeLimit: limit } : {}),
  }
}
