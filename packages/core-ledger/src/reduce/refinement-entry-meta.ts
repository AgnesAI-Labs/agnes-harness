import type { Event, Seq } from '@agnes/core-common/types'
import type { RegisterCell } from './state.js'

/**
 * The Core row that records what a refinement entry is valid for and how often it was confirmed,
 * beside the `harness/entry` row it describes. The entry itself stays the register cell it always
 * was; this metadata is kept apart so an entry never carries unchecked fields of its own.
 */
export const REFINEMENT_ENTRY_META_EVENT = 'x/core/refinement-entry-meta'

/** How long an entry holds: for the task (goal) it was learned in, or for the rest of the session. */
export type RefinementApplicability = 'task' | 'session'

/**
 * One entry's metadata as it folds. It is bound to the `harness/entry` row that set the entry's cell
 * when the metadata was written (`entrySeq`): once the entry is written again by another row, this
 * metadata no longer describes it.
 *
 * - `contentHash` names the content version the confirmations count against; a change of content is
 *   a new version and starts the count over.
 * - `taskScope` is the goal a task-level entry was learned under.
 * - `confirmations.usedEvidence` holds the identities of the evidence already spent on this content
 *   version (on granting its level, or on a confirmation), so no identity counts twice.
 */
export type RefinementEntryMeta = {
  kind: 'prompt' | 'memory' | 'skill' | 'subagent'
  id: string
  contentHash: string
  applicability: RefinementApplicability
  taskScope?: { id: string; revision: number }
  confirmations: { count: number; usedEvidence: string[] }
  lastConfirmedSeq?: Seq
  handedOff?: boolean
  /** The `harness/entry` row this metadata belongs to, and the row that recorded it. */
  entrySeq: Seq
  seq: Seq
}

const KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])
const isSeq = (v: unknown): v is Seq => Number.isSafeInteger(v) && (v as number) >= 0
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The checked metadata a row carries, or undefined when any field is not what Core writes. */
function metaOf(d: Record<string, unknown>): Omit<RefinementEntryMeta, 'entrySeq' | 'seq'> | undefined {
  const { kind, id, contentHash, applicability, taskScope, confirmations, lastConfirmedSeq, handedOff } = d
  if (!KINDS.has(String(kind)) || typeof id !== 'string' || id.length === 0) return undefined
  if (typeof contentHash !== 'string' || contentHash.length === 0) return undefined
  if (applicability !== 'task' && applicability !== 'session') return undefined
  if (
    taskScope !== undefined &&
    !(isObj(taskScope) && typeof taskScope.id === 'string' && isSeq(taskScope.revision))
  )
    return undefined
  if (
    !isObj(confirmations) ||
    !isSeq(confirmations.count) ||
    !Array.isArray(confirmations.usedEvidence) ||
    !confirmations.usedEvidence.every((u) => typeof u === 'string')
  )
    return undefined
  if (lastConfirmedSeq !== undefined && !isSeq(lastConfirmedSeq)) return undefined
  if (handedOff !== undefined && typeof handedOff !== 'boolean') return undefined
  return {
    kind: kind as RefinementEntryMeta['kind'],
    id,
    contentHash,
    applicability,
    ...(isObj(taskScope)
      ? { taskScope: { id: taskScope.id as string, revision: taskScope.revision as Seq } }
      : {}),
    confirmations: {
      count: confirmations.count,
      usedEvidence: [...(confirmations.usedEvidence as string[])],
    },
    ...(lastConfirmedSeq === undefined ? {} : { lastConfirmedSeq }),
    ...(handedOff === undefined ? {} : { handedOff }),
  }
}

/**
 * Folds one `x/core/refinement-entry-meta` row, given the entry's current register cell, or returns
 * undefined to leave the table as it was. Only Core's own rows count (system, trusted, version 1),
 * and only for an entry that exists: the metadata is bound to the row that set that cell, which in
 * an apply is the `harness/entry` row committed just before it in the same transaction. Every field
 * is checked; a row carrying anything else is ignored rather than trusted.
 *
 * A row that records an entry's removal (`removed: true`) is not metadata of a live entry; it is
 * folded by `foldEntryTombstone`. A row of an unknown version is ignored here.
 */
export function foldEntryMeta(
  cell: RegisterCell<unknown> | undefined,
  e: Pick<Event, 'seq' | 'origin' | 'trust' | 'data'>,
): RefinementEntryMeta | undefined {
  const d = e.data
  if (e.origin !== 'system' || e.trust !== 'trusted' || !isObj(d) || d.version !== 1 || !cell)
    return undefined
  if (d.removed !== undefined) return undefined
  const meta = metaOf(d)
  if (!meta) return undefined
  const entry = cell.value as { kind?: unknown; id?: unknown } | null
  if (entry?.kind !== meta.kind || entry.id !== meta.id) return undefined
  return { ...meta, entrySeq: cell.seq, seq: e.seq }
}

/**
 * What a removed entry leaves behind: the last version it had, and the seq of the row that recorded
 * the removal. That seq is the entry's mutation token while it is gone, so "gone" differs from
 * "never existed", and from "gone, written again and gone again"; and an entry written again under
 * the same id continues from `version`, so it never reads as the version that was removed.
 */
export type RefinementEntryTombstone = {
  kind: RefinementEntryMeta['kind']
  id: string
  version: number
  seq: Seq
}

/**
 * Folds one `x/core/refinement-entry-meta` row that records a removal (`removed: true`), given the
 * entry's current register cell. Only Core's own rows count (system, trusted, version 1), and only
 * while the entry is gone: the row is written in the same transaction right after the `harness/entry`
 * tombstone it describes.
 */
export function foldEntryTombstone(
  cell: RegisterCell<unknown> | undefined,
  e: Pick<Event, 'seq' | 'origin' | 'trust' | 'data'>,
): RefinementEntryTombstone | undefined {
  const d = e.data
  if (e.origin !== 'system' || e.trust !== 'trusted' || !isObj(d) || d.version !== 1 || cell) return undefined
  const { kind, id, removed, entryVersion } = d
  if (removed !== true || !KINDS.has(String(kind)) || typeof id !== 'string' || id.length === 0)
    return undefined
  if (!isSeq(entryVersion)) return undefined
  return { kind: kind as RefinementEntryMeta['kind'], id, version: entryVersion, seq: e.seq }
}
