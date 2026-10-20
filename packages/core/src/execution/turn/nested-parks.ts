import type { OpStateObj } from '@agnes/core-common/step/op-state'
import type { EventInput } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { DecisionHandle } from '@agnes/extension-api'
import type { SessionImpl } from '../../step/session.js'

/** A nested call that parked, at any depth below this one, and the question it left open. */
export type NestedPark = { event: EventInput; toolUseId: string }

const APPROVAL_PENDING_TEXT =
  'approval is pending for another call from the same tool; call this again after that approval is settled'

/**
 * The park a tool's nested calls leave the turn on. A turn waits on one approval, so when several
 * nested calls parked at once the first is kept and every later one still awaiting approval is
 * closed here: an `APPROVAL_PENDING` result, its question withdrawn and its batch entry completed,
 * in one commit. An uncertain call already has its result and is left alone.
 */
export async function parkOutcome(
  s: SessionImpl,
  nestedParks: readonly NestedPark[],
  update: (op: OpStateObj | null, toolUseId: string, patch: { status: 'completed' }) => OpStateObj | null,
): Promise<{ park?: EventInput; parkedToolUseId?: string }> {
  const [kept, ...later] = nestedParks
  if (!kept) return {}
  // Only the call that asked is closed, and never one that already has its result.
  const callSeqs = later.flatMap((p) => s.state.toolCalls.get(p.toolUseId)?.seq ?? [])
  const answered = new Set(
    callSeqs.length
      ? (
          await scanAll((q) => s.d.log.scan(q), {
            fromSeq: Math.min(...callSeqs) + 1,
            toSeq: s.lastSeq,
            type: 'tool/result',
            lane: s.lane,
          })
        ).map((row) => (row.data as { toolUseId: string }).toolUseId)
      : [],
  )
  const awaiting = (p: NestedPark) => {
    const op = s.op()
    return (
      !answered.has(p.toolUseId) &&
      op?.phase.kind === 'tools' &&
      op.phase.batch.calls.some((c) => c.toolUseId === p.toolUseId && c.status === 'awaiting_approval')
    )
  }
  if (later.some(awaiting)) {
    let closing: NestedPark[] = []
    await s.transition(
      () => {
        closing = later.filter(awaiting)
        const handles = closing.flatMap((p) =>
          p.event.type === 'x/core/decision-delivery'
            ? [(p.event.data as { handle: DecisionHandle }).handle]
            : [],
        )
        return [
          ...closing.map((p) => {
            const callSeq = s.state.toolCalls.get(p.toolUseId)?.seq
            return s.ev(
              'tool/result',
              {
                toolUseId: p.toolUseId,
                content: [{ type: 'text', text: APPROVAL_PENDING_TEXT }],
                isError: true,
                code: 'APPROVAL_PENDING',
                enforcement: s.d.runtime.enforcement(),
                authz: { decisionId: 'n/a' },
              },
              callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] },
            )
          }),
          ...s.decisions.withdrawnEvents(handles, 'approval-pending'),
        ]
      },
      (cur) => closing.reduce((op, p) => update(op, p.toolUseId, { status: 'completed' }), cur),
    )
  }
  return { park: kept.event, parkedToolUseId: kept.toolUseId }
}
