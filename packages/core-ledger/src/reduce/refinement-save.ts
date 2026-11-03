import type { Event, Seq } from '@agnes/core-common/types'
import type { RefinementEntryKind } from './refinement-run.js'

/** The Core row that records one save of task experience into the workspace: its receipt, never text. */
export const REFINEMENT_SAVE_EVENT = 'x/core/refinement-save'

/** How many separate confirmations an automatic save needs. */
export const PROMOTION_CONFIRMATIONS = 2

/** Who asked to save refined task experience into the workspace. */
export type SaveInitiator = 'auto' | 'user' | 'model'
/** The kind of entry being saved; the same four kinds a refinement entry can have. */
export type SaveKind = RefinementEntryKind

/** The entry a save came from: enough to trace it back and to recognise it again, never its text. */
export type SaveSource = {
  sessionKey: string
  kind: SaveKind
  entryId: string
  contentHash: string
  runId?: string
  initiator: SaveInitiator
}

/** Why a save was refused. */
export type SaveRefusal =
  | 'refinement-off'
  | 'user-revoked'
  | 'unconfirmed'
  | 'source-rules'
  | 'static-check'
  | 'memory-off'
  | 'memory-full'
  | 'unsupported-provider'
  | 'subagent-review-unavailable'
  | 'child-session'
  | 'unavailable'
  | 'conflict'
  | 'approval-expired'

/** The fixed steps every save is judged by, in this order. */
export type SaveStep = 'switch' | 'revocation' | 'confirmations' | 'rules' | 'memory-mode' | 'capacity'

/** What happened to one save request, step by step. Structure and hashes only. */
export type SaveReceipt = {
  receiptId: string
  commandId: string
  initiator: SaveInitiator
  source: SaveSource
  outcome: 'saved' | 'installed' | 'awaiting-approval' | 'refused' | 'unknown'
  reason?: SaveRefusal
  steps: { step: SaveStep; verdict: 'pass' | 'fail' | 'skip' }[]
  target?:
    | { kind: 'memory-paragraph'; paragraphId: string; fileHash: string }
    | { kind: 'skill'; name: string; resourceId: string; revision: string }
  at: number
}

/** A receipt as the session ledger folds it, with the row that last recorded it. */
export type RefinementSaveRecord = SaveReceipt & { seq: Seq }

export const SAVE_STEPS: readonly SaveStep[] = [
  'switch',
  'revocation',
  'confirmations',
  'rules',
  'memory-mode',
  'capacity',
]
export const SAVE_REFUSALS: readonly SaveRefusal[] = [
  'refinement-off',
  'user-revoked',
  'unconfirmed',
  'source-rules',
  'static-check',
  'memory-off',
  'memory-full',
  'unsupported-provider',
  'subagent-review-unavailable',
  'child-session',
  'unavailable',
  'conflict',
  'approval-expired',
]

// The checks rebuild a receipt from its known fields only, so nothing else (an entry's title or text,
// a path) can ride along into the registry or the ledger.
type Raw = Record<string, unknown>
const MAX_TEXT = 4096
/** The shape of a refusal name, for one a later build may add. */
const LATER_REASON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const KINDS = ['prompt', 'memory', 'skill', 'subagent'] as const
const INITIATORS = ['auto', 'user', 'model'] as const
const OUTCOMES = ['saved', 'installed', 'awaiting-approval', 'refused', 'unknown'] as const
const VERDICTS = ['pass', 'fail', 'skip'] as const
const RECEIPT_FIELDS = new Set([
  'receiptId',
  'commandId',
  'initiator',
  'source',
  'outcome',
  'reason',
  'steps',
  'target',
  'at',
])
const obj = (value: unknown): Raw | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : undefined
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find((candidate) => candidate === value)

/** A source rebuilt from its known fields, or undefined when any field is not what a save writes. */
export function checkedSource(value: unknown): SaveSource | undefined {
  const raw = obj(value)
  if (!raw) return undefined
  const sessionKey = text(raw.sessionKey)
  const kind = oneOf(raw.kind, KINDS)
  const entryId = text(raw.entryId)
  const contentHash = text(raw.contentHash)
  const initiator = oneOf(raw.initiator, INITIATORS)
  const runId = raw.runId === undefined ? undefined : text(raw.runId)
  if (!sessionKey || !kind || !entryId || !contentHash || !initiator) return undefined
  if (raw.runId !== undefined && runId === undefined) return undefined
  return { sessionKey, kind, entryId, contentHash, ...(runId === undefined ? {} : { runId }), initiator }
}

function checkedTarget(value: unknown): SaveReceipt['target'] | null | undefined {
  if (value === undefined) return null
  const raw = obj(value)
  if (raw?.kind === 'memory-paragraph') {
    const paragraphId = text(raw.paragraphId)
    const fileHash = text(raw.fileHash)
    return paragraphId && fileHash ? { kind: 'memory-paragraph', paragraphId, fileHash } : undefined
  }
  if (raw?.kind === 'skill') {
    const name = text(raw.name)
    const resourceId = text(raw.resourceId)
    const revision = text(raw.revision)
    return name && resourceId && revision ? { kind: 'skill', name, resourceId, revision } : undefined
  }
  return undefined
}

/**
 * A receipt rebuilt from its known fields, or undefined when any of them is not what a save writes. A
 * step keeps only its name and verdict. A reason is one of the refusal names, or one a later build may
 * add, kept as it is when it has a refusal name's shape (lower-case words joined by hyphens, at most 64
 * characters): a receipt written by a newer build must never make the records unreadable here.
 */
export function checkedReceipt(value: unknown): SaveReceipt | undefined {
  const raw = obj(value)
  if (!raw) return undefined
  const receiptId = text(raw.receiptId)
  const commandId = text(raw.commandId)
  const initiator = oneOf(raw.initiator, INITIATORS)
  const source = checkedSource(raw.source)
  const outcome = oneOf(raw.outcome, OUTCOMES)
  const reason =
    raw.reason === undefined
      ? undefined
      : (oneOf(raw.reason, SAVE_REFUSALS) ??
        (typeof raw.reason === 'string' && raw.reason.length <= 64 && LATER_REASON.test(raw.reason)
          ? (raw.reason as SaveRefusal)
          : undefined))
  const target = checkedTarget(raw.target)
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined
  if (!receiptId || !commandId || !initiator || !source || !outcome || at === undefined) return undefined
  if (target === undefined || (raw.reason !== undefined && reason === undefined)) return undefined
  if (!Array.isArray(raw.steps)) return undefined
  const steps: SaveReceipt['steps'] = []
  for (const entry of raw.steps) {
    const step = oneOf(obj(entry)?.step, SAVE_STEPS)
    const verdict = oneOf(obj(entry)?.verdict, VERDICTS)
    if (!step || !verdict) return undefined
    steps.push({ step, verdict })
  }
  return {
    receiptId,
    commandId,
    initiator,
    source,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    steps,
    ...(target === null ? {} : { target }),
    at,
  }
}

/**
 * Folds one `x/core/refinement-save` row, or returns undefined to leave the table as it was. Only
 * Core's own rows count (system, trusted, version 1), and only a receipt whose every field is what a
 * save writes: a row that carries anything more (an entry's title or text) is ignored, not trusted.
 * A later row for the same receipt (an outcome that was not known yet) replaces the earlier one.
 */
export function foldRefinementSave(
  e: Pick<Event, 'seq' | 'origin' | 'trust' | 'data'>,
): RefinementSaveRecord | undefined {
  const d = obj(e.data)
  if (e.origin !== 'system' || e.trust !== 'trusted' || !d || d.version !== 1) return undefined
  const { version: _version, ...fields } = d
  if (Object.keys(fields).some((key) => !RECEIPT_FIELDS.has(key))) return undefined
  const receipt = checkedReceipt(fields)
  if (!receipt) return undefined
  if (Object.keys(obj(fields.source) ?? {}).some((key) => !(key in receipt.source))) return undefined
  return { ...receipt, seq: e.seq }
}
