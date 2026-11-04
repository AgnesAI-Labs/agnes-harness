import type { EventInput } from '@agnes/core-common/types'
import { runInference as runPreparedInference } from '../execution/turn/inference.js'
import type { SessionImpl, StepOutcome } from '../step/session.js'
import {
  deriveExperienceNotes,
  EXPERIENCE_PREFIX,
  type ExperienceStamp,
  experienceChanged,
  messageText,
  stampChanged,
} from './experience.js'

/**
 * The last check that a request's task-experience notes still hold, made inside the transaction that
 * dispatches the request, under the session writer lock: a withdrawal or a switch-off that committed
 * after the request was derived, however late, means the request is not sent but prepared again.
 */

/** Thrown from inside the dispatch commit when the notes no longer hold; nothing was written. */
class ExperienceChangedSinceDerive extends Error {}

/** The commit option the dispatch transaction runs under. */
export const experienceCommitCheck = (s: SessionImpl): { commitCheck: () => void } => ({
  commitCheck: () => {
    if (experienceChanged(s)) throw new ExperienceChangedSinceDerive('task experience changed')
  },
})

/**
 * One inference step, prepared again when its dispatch commit found the task experience changed. The
 * tree reservation was released on the way out; the program counter has not moved, so the stepper
 * prepares the request afresh.
 */
export async function runInference(s: SessionImpl): Promise<StepOutcome> {
  try {
    return await runPreparedInference(s)
  } catch (error) {
    if (error instanceof ExperienceChangedSinceDerive) return { phase: 'inference' }
    throw error
  }
}

/** Whether a request's written notes include a task-experience note. */
const carriesExperience = (notes: readonly EventInput[]): boolean =>
  notes.some(
    (note) =>
      note.type === 'user/message' &&
      messageText((note.data as { content?: unknown } | null)?.content).startsWith(EXPERIENCE_PREFIX),
  )

/**
 * Whether a loop's request, derived from the surface when `stamp` was taken, must not be sent: task
 * experience changed since (an entry, its metadata, a removal, the switch), and the request either
 * carries task-experience notes or would carry some if derived now. A request built from the loop's
 * own messages has no stamp and carries none; a session that was never given experience and still
 * would not be is never refused.
 */
export async function loopRequestStale(
  s: SessionImpl,
  stamp: ExperienceStamp | undefined,
  notes: readonly EventInput[],
): Promise<boolean> {
  if (!stamp || !stampChanged(stamp, s)) return false
  if (carriesExperience(notes)) return true
  return (await deriveExperienceNotes(s, s.surface())).length > 0
}
