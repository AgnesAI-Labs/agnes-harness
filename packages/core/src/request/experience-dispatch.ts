import { CoreError } from '@agnes/core-common/types'
import { runInference as runPreparedInference } from '../execution/turn/inference.js'
import type { SessionImpl, StepOutcome } from '../step/session.js'
import { type ExperienceStamp, savedViewChange, stampChanged } from './experience.js'

/** A refused dispatch leaves the program counter ready for another derivation. */
export class ExperienceChangedSinceDerive extends CoreError {
  constructor() {
    super('E_REQUEST_FROZEN', 'Task experience changed; prepare the request again')
  }
}

export async function loopRequestStale(s: SessionImpl, stamp?: ExperienceStamp): Promise<boolean> {
  return !!stamp && (stampChanged(stamp, s) || (await savedViewChange(s, stamp)) !== undefined)
}

/** Revalidate external listings inside the append queue, then check synchronous state at commit. */
export function experienceCommitCheck(s: SessionImpl, stamp?: ExperienceStamp) {
  return {
    ...(stamp?.savedView && {
      beforeCommit: async () => {
        if (stampChanged(stamp, s)) throw new ExperienceChangedSinceDerive()
        const change = await savedViewChange(s, stamp)
        // Both derivation and dispatch tried to verify active or owed entries. A fresh turn
        // can retry the unavailable host without spinning the stepper on the same failed reads.
        if (change === 'unavailable' && stamp.savedView?.digest === undefined)
          throw new CoreError('E_REQUEST_FROZEN', 'Saved task experience is unavailable; retry the request')
        if (change) throw new ExperienceChangedSinceDerive()
      },
    }),
    commitCheck: () => {
      if (stamp && stampChanged(stamp, s)) throw new ExperienceChangedSinceDerive()
    },
  }
}

const MAX_EXPERIENCE_REDERIVES = 5
const staleAttempts = new WeakMap<SessionImpl, { turn: number; step: number; count: number }>()

export async function runInference(s: SessionImpl): Promise<StepOutcome> {
  try {
    const result = await runPreparedInference(s)
    staleAttempts.delete(s)
    return result
  } catch (error) {
    const op = s.op()
    if (error instanceof ExperienceChangedSinceDerive && op) {
      const { turn } = op.meta
      const prior = staleAttempts.get(s)
      const count = prior?.turn === turn && prior.step === op.step ? prior.count + 1 : 1
      if (count < MAX_EXPERIENCE_REDERIVES) {
        staleAttempts.set(s, { turn, step: op.step, count })
        return { phase: 'inference' }
      }
      staleAttempts.delete(s)
      throw new CoreError(
        'E_REQUEST_FROZEN',
        'Task experience changed repeatedly before dispatch; retry the request',
      )
    }
    staleAttempts.delete(s)
    throw error
  }
}
