import type { LoopStepOutcome } from '@agnes/extension-api'
import type { StepOutcome } from '../step/session.js'

/** Translate controlled ledger operations at the public boundary, never custom driver phases. */
export function publicOutcome(result: StepOutcome): LoopStepOutcome {
  const outcome = result.phase === 'idle' ? 'idle'
    : result.reason === 'parked' ? 'parked'
    : result.phase === 'terminal' ? 'turn-ended' : 'running'
  return { ...result, outcome }
}
