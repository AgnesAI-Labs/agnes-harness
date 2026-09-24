import { validateOpState } from '@agnes/protocol'
import { LedgerIntegrityFailure } from '../log/integrity.js'
import { scanPages } from '../log/scan-pages.js'
import type { SessionLogImpl } from '../log/session-log.js'
import type { OpStateObj } from '../step/op-state.js'
import type { Seq } from '../types.js'
import type { LedgerState } from './state.js'

/** Call states that say the call has not been dispatched yet. */
const NOT_DISPATCHED = new Set(['planned', 'awaiting_approval', 'approved'])

/**
 * Checks the program-counter cells the store handed back against the verified ledger. The cells are
 * not folded from rows, so nothing can rebuild a wrong one: any disagreement fails the open.
 *
 * A turn is open on a lane exactly when that lane has a cell; the cell is well formed, names that
 * lane and that turn, and was written inside the turn. A call the ledger shows an `effect/intent`
 * for cannot be back in a state before dispatch: the intent is committed with `dispatch_pending`,
 * and every return to `planned` happens before it.
 */
export async function verifyOpCells(log: SessionLogImpl, state: LedgerState): Promise<void> {
  const cells = log.allRegisters().filter((row) => row.register === 'op.state')
  const refuse = (reason: string, lane: string): never => {
    throw new LedgerIntegrityFailure(`program counter ${reason}`, { lane })
  }
  // A child that never wrote its first row folds only its parent's prefix, whose open turn is not its
  // own; it has no counter of its own either.
  if (log.parent && log.lastSeq === log.parent.boundarySeq) {
    const [cell] = cells
    if (cell) refuse('held by a child that has not started', cell.key)
    return
  }
  for (const lane of new Set([...state.openTurn.keys(), ...cells.map((cell) => cell.key)])) {
    const turn = state.openTurn.get(lane)
    const cell = cells.find((row) => row.key === lane)
    if (!turn) return refuse('left over on a lane with no open turn', lane)
    if (!cell) return refuse('missing for an open turn', lane)
    if (cell.data === null || !validateOpState(cell.data).ok) return refuse('outside its schema', lane)
    const op = cell.data as OpStateObj
    if (op.meta.lane !== lane) refuse('names another lane', lane)
    if (op.meta.turn !== turn.turn) refuse('names another turn', lane)
    if (op.meta.triggerSeq > log.lastSeq || cell.seq > log.lastSeq || cell.seq < turn.startSeq)
      refuse('written outside its turn', lane)
    await checkCalls(log, lane, turn.startSeq, op, refuse)
  }
}

async function checkCalls(
  log: SessionLogImpl,
  lane: string,
  fromSeq: Seq,
  op: OpStateObj,
  refuse: (reason: string, lane: string) => never,
): Promise<void> {
  if (op.phase.kind !== 'tools') return
  const waiting = new Set(
    op.phase.batch.calls.filter((call) => NOT_DISPATCHED.has(call.status)).map((call) => call.toolUseId),
  )
  if (waiting.size === 0) return
  // The batch starts at its assistant message; a resumed approval names one from an earlier turn.
  const from = Math.max(fromSeq, op.phase.batch.assistantSeq)
  const pages = scanPages((q) => log.scan(q), {
    fromSeq: from,
    toSeq: log.lastSeq,
    type: 'effect/intent',
    lane,
  })
  for await (const intents of pages)
    for (const intent of intents) {
      const data = intent.data as { kind?: unknown; tool?: { toolUseId?: unknown } } | null
      if (data?.kind === 'tool' && waiting.has(String(data.tool?.toolUseId)))
        refuse('shows a dispatched call as not yet dispatched', lane)
    }
}
