import type { OpStateObj } from '@agnes/core-common/step/op-state'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Actor } from '@agnes/protocol'
import type { RequestHeaderData } from '../request/derive.js'
import { UNATTENDED_ACTOR_ATTR, unattendedInput } from './inbox.js'
import { toolsForAttendance } from './model-tools.js'
import type { SessionImpl, TurnMemory } from './session.js'
import { turnTimeLimit } from './time-limit.js'

/** Turns whose trigger declared that nobody attends them. Turn memory is per process and rebuilt on recovery. */
const unattendedTurns = new WeakSet<TurnMemory>()

/**
 * A turn whose trigger input declared that nobody attends it (`agh -p`, `agh run`, `runHeadless`):
 * its frozen catalog holds no `requiresUser` tool, and request assembly adds the unattended-run
 * note (see `isUnattended`). An attended turn is returned unchanged.
 */
export function attend(turn: TurnMemory, trigger: Pick<Actor, 'attrs'> | undefined): TurnMemory {
  if (!unattendedInput(trigger)) return turn
  const narrowed = { ...turn, snapshot: toolsForAttendance(turn.snapshot, true) }
  unattendedTurns.add(narrowed)
  return narrowed
}

export function isUnattended(turn: TurnMemory): boolean {
  return unattendedTurns.has(turn)
}

/** Whether the session's open turn has nobody attending it; no open turn is attended. */
export function sessionUnattended(s: Pick<SessionImpl, 'turn'>): boolean {
  return s.turn !== null && isUnattended(s.turn)
}

/**
 * A turn that gets progress checks: they are on (preset `loop.progress_check_steps`, off unless set),
 * and nobody attends the turn or its prompt set a limit of its own (time, steps or credits). An
 * ordinary interactive turn never does.
 */
export function progressChecked(s: Pick<SessionImpl, 'preset'>, turn: TurnMemory): boolean {
  return (
    s.preset.progressCheck.everySteps > 0 &&
    (isUnattended(turn) ||
      turnTimeLimit(turn) !== undefined ||
      turn.maxStepsCap !== undefined ||
      turn.budgetCap !== undefined)
  )
}

/**
 * The actor of an input a parent's turn hands to a child session it opened. A child cannot ask a
 * person when its parent cannot, so the input of a child opened from an unattended turn declares
 * the same and the child's turn is narrowed like its parent's. The declaration lands on the child's
 * own trigger row, so the child's recovery reads it back without the parent. A child of an attended
 * turn keeps the actor unchanged.
 */
export function childInputActor(parent: Pick<SessionImpl, 'turn'>, actor: Actor): Actor {
  if (!parent.turn || !isUnattended(parent.turn)) return actor
  return { ...actor, attrs: { ...actor.attrs, [UNATTENDED_ACTOR_ATTR.key]: UNATTENDED_ACTOR_ATTR.value } }
}

/** Recovery reads the declaration back from the trigger row itself, never from process memory. */
export async function attendRecovered(s: SessionImpl, op: OpStateObj, turn: TurnMemory): Promise<TurnMemory> {
  const range = { fromSeq: op.meta.triggerSeq, toSeq: op.meta.triggerSeq, limit: 1 }
  const [trigger] = await s.d.log.scan(range)
  return attend(turn, trigger?.actor)
}

/** Restore request identity and tool ordinals from the persisted turn rather than a fresh counter. */
export async function rehydratedCallState(s: SessionImpl, op: OpStateObj) {
  const range = { fromSeq: op.meta.triggerSeq, toSeq: s.lastSeq, lane: s.lane }
  const [lastRow] = await s.d.log.scan({ ...range, type: 'request/header', order: 'desc', limit: 1 })
  const last = lastRow?.data as RequestHeaderData | undefined
  let calls = 0
  for await (const page of scanPages((q) => s.d.log.scan(q), { ...range, type: 'tool/call' }))
    calls += page.length
  const ordinal =
    op.phase.kind === 'tools' ? Math.max(calls, ...op.phase.batch.calls.map((c) => c.ordinal + 1)) : calls
  return { lastRow, last, ordinal }
}
