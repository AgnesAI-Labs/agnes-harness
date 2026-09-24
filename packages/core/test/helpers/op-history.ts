import type { OpState } from '@agnes/protocol'
import type { SessionLogImpl } from '../../src/log/session-log.js'
import type { RegisterRow } from '../../src/log/storage.js'
import type { Seq } from '../../src/types.js'

/** One program-counter value a commit wrote: `null` when the commit removed the lane's cell. */
export type OpWriteSeen = { lane: string; seq: Seq; data: OpState }

/**
 * Follows a live log's program-counter cells commit by commit. The counter is a register cell, not a
 * ledger row, so a test that wants its history, or cuts a finished ledger short to fake a crash,
 * reads it here: `before(seq)` is what a store held once every commit ending before `seq` had landed
 * and none after, and `writes()` is every value the commits wrote, in order.
 */
export function opHistory(log: SessionLogImpl): {
  before: (seq: Seq) => RegisterRow[]
  writes: () => OpWriteSeen[]
} {
  const cells = () => structuredClone(log.allRegisters().filter((row) => row.register === 'op.state'))
  const history: Array<{ end: Seq; cells: RegisterRow[] }> = [{ end: log.lastSeq, cells: cells() }]
  const written: OpWriteSeen[] = []
  log.observeCommitted('*', (events) => {
    const end = events.at(-1)?.seq
    if (end === undefined) return
    const now = cells()
    const was = history.at(-1)?.cells ?? []
    for (const cell of now)
      if (cell.seq === end) written.push({ lane: cell.key, seq: end, data: cell.data as OpState })
    for (const cell of was)
      if (!now.some((row) => row.key === cell.key)) written.push({ lane: cell.key, seq: end, data: null })
    history.push({ end, cells: now })
  })
  return {
    before: (seq) => {
      const at = history.filter((entry) => entry.end < seq).at(-1)
      if (!at) throw new Error(`no commit ended before seq ${seq}`)
      return structuredClone(at.cells)
    },
    writes: () => structuredClone(written),
  }
}
