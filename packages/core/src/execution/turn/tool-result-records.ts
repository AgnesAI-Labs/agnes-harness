import type { EventInput } from '@agnes/core-common/types'
import type { DispatchPhase } from '@agnes/protocol'
import type { SessionImpl } from '../../step/session.js'

/** Keep dispatch evidence outside the client-visible result and in its same ledger transaction. */
export function toolResultRecords(
  session: Pick<SessionImpl, 'ev'>,
  input: Record<string, unknown> & { toolUseId: string; dispatchPhase?: DispatchPhase | undefined },
  extra: Partial<EventInput>,
): EventInput[] {
  const { dispatchPhase, ...result } = input
  const rows: EventInput[] = []
  if (dispatchPhase)
    rows.push(
      session.ev(
        'x/core/tool-dispatch',
        { version: 1, toolUseId: result.toolUseId, phase: dispatchPhase },
        { ignorable: true, ...(extra.sourceEventSeqs ? { sourceEventSeqs: extra.sourceEventSeqs } : {}) },
      ),
    )
  // The fact precedes the result, including results arriving after turn/end.
  rows.push(session.ev('tool/result', result, extra))
  return rows
}
