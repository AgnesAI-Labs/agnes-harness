import type { EventInput } from '@agnes/core-common/types'
import type { SaveReceipt } from '@agnes/core-ledger/reduce/refinement-save'
import { entryKey } from '../refine/apply.js'
import type { SessionImpl } from '../step/session.js'
import { currentMeta, metaRow } from './confirmations.js'
import { contentHash } from './validity.js'
import type { WorkspaceSaveRequest } from './workspace.js'

/** The diagnostic row for an expected change of the system prefix: the skill catalogue changed. */
const catalogChanged = (s: SessionImpl): EventInput =>
  s.ev('x/core/refinement-prefix-change', { reason: 'skill-catalog' }, { ignorable: true })

/**
 * The rows that go with a receipt saying a skill entry was installed into the workspace as a skill, in
 * the same transaction as the receipt row. Read under the session lock.
 *
 * - The workspace skill catalogue changes, and with it the system prefix of the next request: that is
 *   recorded as an expected change, once per receipt (a repeat of a receipt already recorded adds none).
 * - The entry hands off to the skill: its metadata says `handedOff`, so it is no longer delivered and
 *   no longer counts toward the cap, and the model is told once to use the skill instead. Only while
 *   the entry still holds the content version that was installed; a newer version stays an entry.
 */
export function skillInstalledRows(
  s: SessionImpl,
  request: WorkspaceSaveRequest,
  receipt: SaveReceipt,
): EventInput[] {
  if (receipt.outcome !== 'installed' || receipt.target?.kind !== 'skill' || request.entry.kind !== 'skill')
    return []
  const rows: EventInput[] = []
  const recorded = s.state.refinementSaves.get(receipt.receiptId)
  if (recorded?.outcome !== 'installed') rows.push(catalogChanged(s))
  const cell = s.state.registers.harnessEntries.get(entryKey(request.entry))
  if (!cell || typeof cell.value.content !== 'string') return rows
  if (contentHash(cell.value.content) !== request.entry.contentHash) return rows
  const meta = currentMeta(s.state, cell.value)
  if (meta.handedOff === true) return rows
  rows.push(metaRow(s, { ...meta, handedOff: true }))
  return rows
}
