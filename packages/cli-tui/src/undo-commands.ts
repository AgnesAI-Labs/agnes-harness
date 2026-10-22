import { randomUUID } from 'node:crypto'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { formatUndoPreview, formatUndoResult, undoRefusalText } from './undo-format.js'

type Pending = { turn: number; commandId: string }
const pending = new WeakMap<object, Pending>()

/**
 * /undo previews the last file-changing turn, /undo N a given one; /undo confirm applies the preview
 * through the daemon, which decides again whether the turn can be undone. A retry after a lost answer
 * keeps its commandId, so the daemon never applies one confirmation twice.
 */
export async function undoSlash(app: TuiApp, args: readonly string[]): Promise<SlashResult> {
  const locale = app.locale
  const session = app.session
  const arg = args[0]
  if (arg === 'cancel') {
    pending.delete(session)
    return { text: tt('undo.cancelled', locale) }
  }
  try {
    if (arg === 'confirm') {
      const next = pending.get(session)
      if (!next) return { text: tt('undo.noPending', locale) }
      const result = await session.undo(next.turn, { commandId: next.commandId })
      pending.delete(session)
      return { text: formatUndoResult(result, locale), presentation: 'transcript' }
    }
    const turn = arg === undefined ? undefined : Number(arg)
    if (turn !== undefined && (!Number.isInteger(turn) || turn < 1))
      return { text: 'usage: /undo [turn|confirm|cancel]' }
    const preview = await session.undoPreview(turn)
    if (preview.undoable && preview.turn !== undefined) {
      pending.set(session, { turn: preview.turn, commandId: randomUUID() })
      return {
        text: `${formatUndoPreview(preview, locale)}\n${tt('undo.confirm', locale)}`,
        presentation: 'transcript',
      }
    }
    pending.delete(session)
    return { text: formatUndoPreview(preview, locale), presentation: 'transcript' }
  } catch (error) {
    // A refusal is final for this confirmation; anything unknown (a dropped connection) keeps it for a retry.
    const refusal = undoRefusalText(error, locale)
    if (!refusal) throw error
    if (arg === 'confirm') pending.delete(session)
    return { text: refusal, presentation: 'transcript' }
  }
}
