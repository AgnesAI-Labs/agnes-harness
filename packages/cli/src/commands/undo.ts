import { formatUndoPreview, formatUndoResult, undoRefusalText } from '@agnes/cli-tui'
import type { NodeClient } from '@agnes/sdk'
import { CommandError, ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

/**
 * `agh sessions undo <key> [--turn N] [--yes]`: without --yes only the daemon's preview is printed and
 * nothing changes. With --yes the turn is undone, but only when the preview says it can be; the daemon
 * decides again, and its refusal (a turn running, a file changed since, a read-only session) is shown.
 */
export async function undoCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const key = p.positional[1]
  if (!key || p.positional.length > 2)
    throw new UsageError('sessions undo expects <key> [--turn <n>] [--yes]')
  const turn = p.turn === undefined ? undefined : Number(p.turn)
  if (turn !== undefined && (!Number.isSafeInteger(turn) || turn < 1))
    throw new UsageError('--turn expects a positive integer')
  const session = await client.session.open(key, p.cwd ? { cwd: p.cwd } : {})
  const refused = (error: unknown): never => {
    const text = undoRefusalText(error, 'en')
    if (text) throw new CommandError(text)
    throw error
  }
  const preview = await session.undoPreview(turn).catch(refused)
  if (!p.yes || !preview.undoable || preview.turn === undefined) {
    io.stdout.write(
      p.json
        ? `${JSON.stringify(preview)}\n`
        : `${formatUndoPreview(preview, 'en')}\n${p.yes ? '' : 'Preview only: nothing was changed. Add --yes to undo.\n'}`,
    )
    return p.yes ? ExitCode.ERROR : ExitCode.OK
  }
  const result = await session.undo(preview.turn).catch(refused)
  io.stdout.write(p.json ? `${JSON.stringify(result)}\n` : `${formatUndoResult(result, 'en')}\n`)
  return result.failed.length === 0 ? ExitCode.OK : ExitCode.ERROR
}
