import type { EventInput, Seq } from '@agnes/core-common/types'
import {
  REFINEMENT_SAVE_EVENT,
  type SaveInitiator,
  type SaveReceipt,
} from '@agnes/core-ledger/reduce/refinement-save'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import { MAINTENANCE_LANE } from '@agnes/core-ledger/reduce/state'
import { entryKey } from '../refine/apply.js'
import { isChildSession } from '../step/child-session.js'
import { sysEvent } from '../step/events.js'
import type { SessionImpl } from '../step/session.js'
import { settingsOf } from './scheduler.js'
import { skillInstalledRows } from './skill-handoff.js'
import { contentHash } from './validity.js'

export type { SaveInitiator, SaveReceipt } from '@agnes/core-ledger/reduce/refinement-save'

/**
 * One request to save a session's refinement entry into its workspace, as Core states it to the host.
 * Everything in it comes from the session's own ledger: the model never supplies the workspace, the
 * evidence or the entry's level.
 *
 * - `session.workspaceRoot` is the session's canonical workspace; `lastSeq` is the last row of the
 *   session's ledger when the request was made, so every evidence seq in `[1, lastSeq]` is a row of
 *   this session. `child` is true for a delegated child, a role child or a fork.
 * - `settingsRevision` is the refinement switch revision the request was made under; a save is
 *   refused once it has moved.
 * - `entry.contentHash` is Core's hash of the content version the request is for; `applicability` is
 *   the level the entry holds (`task` when its metadata does not say).
 * - `evidenceTurn` is the turn the evidence came from, recorded with the memory write.
 */
export type WorkspaceSaveRequest = {
  initiator: SaveInitiator
  commandId: string
  session: { key: string; lane: string; workspaceRoot: string; lastSeq: Seq; child: boolean }
  settingsRevision: string
  entry: {
    kind: HarnessEntry['kind']
    id: string
    version: number
    contentHash: string
    title: string
    content: string
    applicability: 'task' | 'session'
    /** The approved skill or role a skill or subagent entry is bound to, when it is. */
    reference?: string
  }
  evidenceSeqs: Seq[]
  evidenceTurn?: number
  confirmations: number
  runId?: string
}

/**
 * The host's one save-to-workspace path. It judges every request in the same fixed order whoever
 * asked, and always answers with a receipt (a refusal is a receipt too); it never throws for a
 * refusal.
 */
export type RefinementWorkspacePort = {
  save(request: WorkspaceSaveRequest): Promise<SaveReceipt>
  /**
   * The current receipts among `receiptIds` whose outcome is known by now: a save cut off before its
   * result was recorded is settled by the host later. Absent where the host cannot tell.
   */
  settled?(workspaceRoot: string, receiptIds: readonly string[]): Promise<SaveReceipt[]>
}

/** What a save of one entry came to: the host's receipt, or why it was never asked. */
export type WorkspaceSaveOutcome = { receipt: SaveReceipt } | { refused: 'unavailable' | 'not-found' }

/** What an entry point says about the save it wants. */
export type WorkspaceSaveInput = {
  initiator: SaveInitiator
  kind: HarnessEntry['kind']
  id: string
  /** The caller's idempotency key; a fresh one is made when absent. */
  commandId?: string
  /** The evidence the entry stands on; absent, the evidence of the applied plan that wrote it. */
  evidenceSeqs?: readonly Seq[]
  runId?: string
}

/** The row a receipt is recorded as in the session ledger, on the maintenance lane. Never any text. */
export const refinementSaveRow = (s: SessionImpl, receipt: SaveReceipt): EventInput =>
  sysEvent(
    { actor: s.d.actor, lane: MAINTENANCE_LANE },
    REFINEMENT_SAVE_EVENT,
    { version: 1, ...receipt },
    {
      ignorable: true,
    },
  )

/** The evidence of the applied plan whose upsert wrote the entry's current content; newest first wins. */
function plannedEvidence(s: SessionImpl, entry: HarnessEntry): Seq[] {
  let found: { seq: Seq; evidence: Seq[] } | undefined
  for (const run of s.state.refinementRuns.values()) {
    if (run.state !== 'applied' || !run.plan) continue
    for (const edit of run.plan.edits)
      if (
        edit.op === 'upsert' &&
        edit.kind === entry.kind &&
        edit.id === entry.id &&
        edit.content === entry.content &&
        (!found || run.seq > found.seq)
      )
        found = { seq: run.seq, evidence: [...edit.evidenceSeqs] }
  }
  return found?.evidence ?? []
}

/** The request for one live entry of this session, or undefined when there is no such entry. */
export function workspaceSaveRequest(
  s: SessionImpl,
  input: WorkspaceSaveInput,
): WorkspaceSaveRequest | undefined {
  const key = entryKey(input)
  const cell = s.state.registers.harnessEntries.get(key)
  const entry = cell?.value as HarnessEntry | undefined
  if (!cell || !entry || typeof entry.content !== 'string' || typeof entry.title !== 'string')
    return undefined
  // Metadata describes the entry only while it is bound to the row that set the entry's cell.
  const meta = s.state.refinementEntryMeta.get(key)
  const current = meta && meta.entrySeq === cell.seq ? meta : undefined
  const lastTurn = s.state.lastTurn.get(s.lane)
  return {
    initiator: input.initiator,
    commandId: input.commandId ?? s.d.ids.ulid(),
    session: {
      key: s.key,
      lane: s.lane,
      workspaceRoot: s.workspaceRoot,
      lastSeq: s.lastSeq,
      child: isChildSession(s),
    },
    settingsRevision: settingsOf(s)?.revision ?? '',
    entry: {
      kind: entry.kind,
      id: entry.id,
      version: typeof entry.version === 'number' ? entry.version : 0,
      contentHash: current?.contentHash ?? contentHash(entry.content),
      title: entry.title,
      content: entry.content,
      applicability: current?.applicability ?? 'task',
      ...(typeof entry.reference === 'string' ? { reference: entry.reference } : {}),
    },
    evidenceSeqs: [...(input.evidenceSeqs ?? plannedEvidence(s, entry))],
    ...(lastTurn === undefined ? {} : { evidenceTurn: lastTurn }),
    confirmations: current?.confirmations.count ?? 0,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  }
}

/**
 * Saves one of this session's entries into its workspace through the host's save path, and records
 * the receipt in the session ledger (a skill installed hands its entry off, `skillInstalledRows`). Every entry point calls this one function; the host alone judges
 * the request. Nothing is written while refinement is off, and the call never waits for the host
 * while holding the session.
 */
export async function saveToWorkspace(
  s: SessionImpl,
  input: WorkspaceSaveInput,
): Promise<WorkspaceSaveOutcome> {
  const port = s.d.refinement?.workspace
  if (!port) return { refused: 'unavailable' }
  const request = workspaceSaveRequest(s, input)
  if (!request) return { refused: 'not-found' }
  let receipt: SaveReceipt
  try {
    receipt = await port.save(request)
  } catch (error) {
    s.d.logger.warn('refinement workspace save failed', { message: String(error) })
    return { refused: 'unavailable' }
  }
  if (receipt.reason !== 'refinement-off' && !s.closingOrClosed) {
    try {
      await s.locked(() =>
        s.append([refinementSaveRow(s, receipt), ...skillInstalledRows(s, request, receipt)]),
      )
    } catch (error) {
      // The host has already acted on the save; its own registry keeps the receipt.
      s.d.logger.warn('refinement save receipt was not recorded', { message: String(error) })
    }
  }
  return { receipt }
}

/**
 * Records in the session ledger how this session's saves whose outcome was not known have ended, once
 * the host has settled them (a save cut off between its file commit and its result). Nothing is asked
 * while refinement is off or when no save of this session is unknown. Never throws.
 */
export async function recordSettledSaves(s: SessionImpl): Promise<void> {
  const settled = s.d.refinement?.workspace?.settled
  if (!settled || !settingsOf(s)) return
  const open = [...s.state.refinementSaves.values()]
    .filter((saved) => saved.outcome === 'unknown' && saved.reason === undefined)
    .map((saved) => saved.receiptId)
  if (!open.length) return
  try {
    const wanted = new Set(open)
    const known = (await settled(s.workspaceRoot, open)).filter(
      (receipt) =>
        wanted.has(receipt.receiptId) && (receipt.outcome !== 'unknown' || receipt.reason !== undefined),
    )
    if (known.length && !s.closingOrClosed)
      await s.locked(() => s.append(known.map((receipt) => refinementSaveRow(s, receipt))))
  } catch (error) {
    s.d.logger.warn('refinement save outcomes were not recorded', { message: String(error) })
  }
}
