import { withPhase } from '@agnes/core-common/step/op-state'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import { estimateTokens } from '../execution/model-tokens.js'
import { compactionSettingsFor, compactionTriggerTokens, contextWindowFor } from '../execution/turn/gate.js'
import { resolveModel } from '../execution/turn/inference.js'
import type { SessionImpl, StepOutcome, TurnMemory } from '../step/session.js'
import { type ExperienceNote, experienceNotes, isControlNote } from './experience.js'
import { CONTROL_FORMAT_LINE, EXPERIENCE_OFF_NOTICE, EXPERIENCE_RESET_NOTICE } from './experience-control.js'

/**
 * Room in the context for task-experience notes that carry a control notice.
 *
 * A control notice (an entry withdrawn, expired, or experience switched off) can never be put off
 * while the main request goes out: the model would act on what was withdrawn. So when the notes do
 * not fit below the compaction line (the window less the reserved output), the entry notes are put
 * off first (they stay owed and go with a later request), then the control list gives way to the
 * reset notice, the smallest notice that still withdraws everything. If even that does not fit, a
 * primary turn compacts once (a compaction is a boundary that rebuilds what the model sees, and it
 * offers no refinement trigger of its own); after that, or where compaction is off or not possible,
 * the request is not sent and the turn ends with the reason. Nothing is written for a notice that
 * waits: it is derived from the ledger again for the next request. Without a control notice the
 * notes are left exactly as they are.
 */

/** Per turn: a compaction this module started for room, so it is tried once and offers no trigger. */
const compactedFor = new WeakSet<TurnMemory>()
const pendingTrigger = new WeakSet<SessionImpl>()

/**
 * Whether the compaction that just committed was started only to make room for a control notice:
 * such a compaction offers no refinement trigger (it would only feed a compaction and planning loop).
 * Asking clears the mark.
 */
export function compactedForControl(s: SessionImpl): boolean {
  const marked = pendingTrigger.has(s)
  pendingTrigger.delete(s)
  return marked
}

/** Estimated tokens of a note as it is sent, its envelope included. */
const ENVELOPE_TOKENS = 32
const noteTokens = (notes: readonly ExperienceNote[]) =>
  notes.reduce(
    (sum, n) =>
      sum + estimateTokens(`${n.prefix}${n.text}\n${n.data ?? ''}`) + (n.data ? ENVELOPE_TOKENS : 0),
    0,
  )

/** The room left below the compaction line for this request's task-experience notes. */
function room(s: SessionImpl): number {
  const { route, model } = resolveModel(s, 'primary')
  const window = contextWindowFor(s, route, model)
  const { reserveTokens } = compactionSettingsFor(s, window)
  return window - reserveTokens - compactionTriggerTokens(s)
}

/**
 * The task-experience notes for this request, cut to the room left for them when they carry a control
 * notice, or the step outcome when not even the smallest control notice fits: a compaction for a
 * primary turn (`primary`), else the turn ended for its budget with the reason.
 */
export async function experienceForRequest(
  s: SessionImpl,
  surface: readonly SurfaceNode[],
  primary: boolean,
): Promise<ExperienceNote[] | StepOutcome> {
  const notes = await experienceNotes(s, surface)
  const control = notes.filter(isControlNote)
  if (control.length === 0) return notes
  const left = room(s)
  if (noteTokens(notes) <= left) return notes
  if (noteTokens(control) <= left) return control
  const minimal = control.map((note) =>
    note.text.includes(EXPERIENCE_OFF_NOTICE)
      ? note
      : { ...note, text: `${CONTROL_FORMAT_LINE}\n${EXPERIENCE_RESET_NOTICE}` },
  )
  if (noteTokens(minimal) <= left) return minimal
  const op = s.op()
  const t = s.turn
  if (
    primary &&
    op &&
    t &&
    op.phase.kind === 'inference' &&
    s.preset.compaction.enabled &&
    !compactedFor.has(t)
  ) {
    compactedFor.add(t)
    pendingTrigger.add(s)
    await s.transition(
      [],
      withPhase(op, {
        kind: 'compaction',
        reason: 'requested',
        resumeAfter: { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: op.meta.triggerSeq },
      }),
    )
    return { phase: 'compaction' }
  }
  pendingTrigger.delete(s)
  await s.endTurn('budget', {
    error: {
      code: 'EXPERIENCE_CONTROL_NO_ROOM',
      message:
        'The request was not sent: the context has no room left for the notice that withdraws task experience the model was given. Compact the session or raise its context budget, then continue.',
    },
  })
  return { phase: 'terminal', reason: 'budget' }
}
