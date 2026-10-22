import type { SessionUndoPreviewResult, SessionUndoResult } from '@agnes/protocol'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'
import type { UndoKey } from './locale-undo.js'

const text = (key: UndoKey, locale: string, vars: Record<string, string | number> = {}) =>
  tt(key, locale, vars)
/** Paths and reasons come from the ledger and the daemon: one inert line each. */
const inert = (value: string) => escapeControl(value).replace(/\s+/g, ' ').trim()
const reason = (value: string, locale: string) => {
  const key = `undo.reason.${value}` as UndoKey
  return text(key, locale).startsWith('undo.') ? inert(value) : text(key, locale)
}

export function formatUndoPreview(preview: SessionUndoPreviewResult, locale: string): string {
  if (preview.turn === undefined || preview.files.length === 0)
    return preview.turn === undefined
      ? text('undo.nothing', locale)
      : text('undo.blocked.already-undone', locale)
  const lines = [text('undo.header', locale, { turn: preview.turn, count: preview.files.length })]
  for (const file of preview.files) {
    const key =
      file.action === 'delete'
        ? 'undo.delete'
        : file.action === 'unchanged'
          ? 'undo.unchanged'
          : 'undo.restore'
    lines.push(`  ${text(key, locale, { path: inert(file.path) })}`)
    if (!file.undoable)
      lines.push(`  ${text('undo.kept', locale, { reason: reason(file.reason ?? 'unreadable', locale) })}`)
  }
  if (preview.laterTurns.length > 0)
    lines.push(text('undo.later', locale, { turns: preview.laterTurns.join(', ') }))
  if (preview.shellChanges) lines.push(text('undo.shell', locale))
  if (!preview.undoable && preview.blockedBy !== 'none')
    lines.push(text(`undo.blocked.${preview.blockedBy}` as UndoKey, locale))
  return lines.join('\n')
}

export function formatUndoResult(result: SessionUndoResult, locale: string): string {
  const lines = [
    text(result.failed.length > 0 ? 'undo.partial' : 'undo.done', locale, {
      turn: result.turn,
      count: result.restored.length,
    }),
  ]
  for (const item of result.failed)
    lines.push(text('undo.failedFile', locale, { path: inert(item.path), reason: inert(item.reason) }))
  return lines.join('\n')
}

type RpcLike = { data?: { code?: unknown; conflicts?: unknown; files?: unknown } }
const REFUSALS: Record<string, UndoKey> = {
  SESSION_BUSY: 'undo.refusedBusy',
  UNDO_READ_ONLY: 'undo.refusedReadOnly',
  UNDO_LATER_TURNS: 'undo.refusedLater',
  UNDO_ALREADY_DONE: 'undo.refusedDone',
  UNDO_NOTHING_TO_UNDO: 'undo.refusedNothing',
  UNDO_UNAVAILABLE: 'undo.refusedFiles',
}

/** Whether the daemon predates undo: it answers method-not-found. */
export const undoUnsupported = (error: unknown): boolean =>
  (error as RpcLike | null)?.data?.code === 'METHOD_NOT_FOUND'

/** The refusals the daemon gives for an undo, said in words; anything else is not ours to explain. */
export function undoRefusalText(error: unknown, locale: string): string | undefined {
  if (undoUnsupported(error)) return text('undo.unsupported', locale)
  const data = (error as RpcLike | null)?.data
  const code = typeof data?.code === 'string' ? data.code : undefined
  if (code === 'UNDO_CONFLICT') {
    const conflicts = Array.isArray(data?.conflicts)
      ? (data.conflicts as { path?: unknown; reason?: unknown }[])
      : []
    return [
      text('undo.refusedFiles', locale),
      ...conflicts.map((item) =>
        text('undo.conflict', locale, {
          path: inert(String(item.path ?? '')),
          reason: reason(String(item.reason ?? ''), locale),
        }),
      ),
    ].join('\n')
  }
  const key = code ? REFUSALS[code] : undefined
  return key ? text(key, locale) : undefined
}
