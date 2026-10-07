import type { LoopStepOutcome } from '@agnes/extension-api'
import type { StepOutcome } from '../step/session.js'

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
