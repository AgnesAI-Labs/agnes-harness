import type { OpStateObj } from '@agnes/core-common/step/op-state'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Actor } from '@agnes/protocol'
import type { RequestHeaderData } from '../request/derive.js'
import { unattendedInput } from './inbox.js'
import { toolsForAttendance } from './model-tools.js'
import type { SessionImpl, TurnMemory } from './session.js'

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
