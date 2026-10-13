import type { LoopStepOutcome } from '@agnes/extension-api'
import type { StepOutcome, TurnEndReason } from '../step/session.js'

/** Translate controlled ledger operations at the public boundary, never custom driver phases. */
export function publicOutcome(result: StepOutcome): LoopStepOutcome {
  const outcome =
    result.phase === 'idle'
      ? 'idle'
      : result.reason === 'parked'
        ? 'parked'
        : result.phase === 'terminal'
          ? 'turn-ended'
          : 'running'
  return { ...result, outcome }
}

/** Core schedules by the public outcome and keeps extension runtime imports out of its boundary. */
export function shouldStopLoop(result: LoopStepOutcome, until: 'turn-end' | 'idle'): boolean {
  switch (result.outcome) {
    case 'running':
      return false
    case 'idle':
    case 'parked':
      return true
    case 'turn-ended':
      return until === 'turn-end' || (result.reason ?? 'completed') !== 'completed'
    default:
      throw new Error('Invalid loop step outcome')
  }
}

/**
 * Only Core closes a turn. A driver that reports completion while the stop gate kept the turn open
 * (`openPhase` is the phase of the still-open turn) is still running it.
 */
export function drivenOutcome(out: LoopStepOutcome, openPhase: string | undefined): LoopStepOutcome {
  return openPhase !== undefined &&
    out.outcome === 'turn-ended' &&
    (out.reason ?? 'completed') === 'completed'
    ? { outcome: 'running', phase: openPhase }
    : out
}

const ADMISSION_ENDINGS = new Set(['budget', 'max_steps', 'parked', 'aborted', 'blocked'])
/** The ways step admission ends a turn in Core before a loop port starts any work under the step. */
export function isAdmissionEnding(reason: unknown): reason is TurnEndReason {
  return typeof reason === 'string' && ADMISSION_ENDINGS.has(reason)
}
