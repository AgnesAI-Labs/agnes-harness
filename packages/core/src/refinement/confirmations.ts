import type { EventInput } from '@agnes/core-common/types'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import {
  type LedgerState,
  REFINEMENT_ENTRY_META_EVENT,
  type RefinementEntryMeta,
  type RefinementPlan,
  type RefinementPlanEdit,
} from '@agnes/core-ledger/reduce/state'
import { entryKey } from '../refine/apply.js'
import type { SessionImpl } from '../step/session.js'
import { boundMeta, type Confirmation, contentHash } from './validity.js'

/**
 * Confirmations of refinement entries.
 *
 * An entry's confirmation count belongs to one content version (the hash of its content): any
 * change of content starts it over, while a change of its level alone does not. It counts evidence,
 * not runs: each piece of original evidence has an identity, and one identity counts at most once
 * per content version, however many plans cite it. Evidence spent on granting the entry its level
 * never counts as a confirmation.
 *
 * Identities: a quoted request is `user:<its seq>`; a failed-then-successful pair is
 * `tool:<the success's seq>`; an observed metric is `metric:<its event's seq>`; the user's own
 * confirmation is `user-action`, so it counts once per content version.
 */

/** The fields of an entry's metadata Core writes; the reducer binds it to the entry's row. */
export type EntryMetaData = Omit<RefinementEntryMeta, 'entrySeq' | 'seq'>

/** The metadata after one more confirmation, or undefined when this identity has already counted. */
export function counted(meta: EntryMetaData, by: Confirmation): EntryMetaData | undefined {
  if (meta.confirmations.usedEvidence.includes(by.identity)) return undefined
  return {
    ...meta,
    confirmations: {
      count: meta.confirmations.count + 1,
      usedEvidence: [...meta.confirmations.usedEvidence, by.identity],
    },
    lastConfirmedSeq: Math.max(meta.lastConfirmedSeq ?? 0, by.seq),
  }
}

const strip = ({ entrySeq: _entry, seq: _seq, ...meta }: RefinementEntryMeta): EntryMetaData => meta

/** An entry's current metadata, or what an entry with none (written before metadata existed) reads as. */
export function currentMeta(state: LedgerState, entry: HarnessEntry): EntryMetaData {
  const meta = boundMeta(state, entryKey(entry))
  if (meta) return strip(meta)
  return {
    kind: entry.kind,
    id: entry.id,
    contentHash: contentHash(String(entry.content ?? '')),
    applicability: 'session',
    confirmations: { count: 0, usedEvidence: [] },
  }
}

/**
 * The metadata a written upsert leaves its entry with: the level and goal the plan granted, and the
 * count carried over when the content did not change, else started over with only the evidence
 * that granted the level marked used.
 */
export function upsertMeta(
  state: LedgerState,
  edit: Extract<RefinementPlanEdit, { op: 'upsert' }>,
): EntryMetaData {
  const hash = contentHash(edit.content)
  const cell = state.registers.harnessEntries.get(entryKey(edit))
  const before = cell ? currentMeta(state, cell.value) : undefined
  const kept = before?.contentHash === hash ? before : undefined
  const used = [...new Set([...(kept?.confirmations.usedEvidence ?? []), ...(edit.usedEvidence ?? [])])]
  return {
    kind: edit.kind,
    id: edit.id,
    contentHash: hash,
    applicability: edit.applicability,
    ...(edit.applicability === 'task' && edit.taskScope ? { taskScope: { ...edit.taskScope } } : {}),
    confirmations: { count: kept?.confirmations.count ?? 0, usedEvidence: used },
    ...(kept?.lastConfirmedSeq === undefined ? {} : { lastConfirmedSeq: kept.lastConfirmedSeq }),
    ...(kept?.handedOff === undefined ? {} : { handedOff: kept.handedOff }),
    ...(edit.reach === 'user' ? { reach: 'user' as const } : {}),
  }
}

export const metaRow = (s: SessionImpl, meta: EntryMetaData): EventInput =>
  s.ev(REFINEMENT_ENTRY_META_EVENT, { version: 1, ...meta }, { ignorable: true })

/**
 * The metadata rows an apply of `plan` writes after its entry rows, in the same transaction: one per
 * written upsert, and one per entry a confirmation newly counts for. A confirmation of an entry the
 * same plan rewrites counts nothing: its evidence is older than the new version.
 */
export function applyMetaRows(
  s: SessionImpl,
  plan: RefinementPlan,
  written: readonly RefinementPlanEdit[],
): EventInput[] {
  const rows: EventInput[] = []
  const rewritten = new Set(written.map(entryKey))
  for (const edit of written) if (edit.op === 'upsert') rows.push(metaRow(s, upsertMeta(s.state, edit)))
  for (const c of plan.confirmations) {
    const cell = s.state.registers.harnessEntries.get(entryKey(c))
    if (!c.confirmedBy || !cell || rewritten.has(entryKey(c))) continue
    const next = counted(currentMeta(s.state, cell.value), c.confirmedBy)
    if (next) rows.push(metaRow(s, next))
  }
  return rows
}
