import {
  cleanupWorktree,
  createWorktree,
  type Locale,
  outcomeLine,
  startedNotices,
  tt,
  WorktreeError,
  type WorktreeInfo,
} from '@agnes/cli-tui'
import { UsageError } from './errors.js'
import type { ParsedArgs } from './types.js'

/**
 * `--worktree[=name]`: makes the git worktree before the session opens and points the run at it (`p.cwd`).
 * Refused over `--connect`/`AGNES_CONNECT` and for ACP: both would put a directory on this machine that the
 * session's daemon or client may not share.
 */
export async function openWorktreeFlag(
  p: ParsedArgs,
  mode: 'tui' | 'print' | 'acp',
  io: { cwd: string; env: NodeJS.ProcessEnv },
  locale: Locale,
): Promise<WorktreeInfo | undefined> {
  if (p.worktree === undefined) return undefined
  if (p.continue || p.resume !== undefined || p.command === 'resume')
    throw new UsageError('--worktree starts a new session: it cannot be combined with --continue or --resume')
  if (mode === 'acp') throw new UsageError('--worktree is not supported with ACP')
  if (p.connect !== undefined || io.env.AGNES_CONNECT !== undefined)
    throw new UsageError(tt('worktree.remote', locale))
  try {
    const info = await createWorktree(p.cwd ?? io.cwd, p.worktree || undefined, locale)
    p.cwd = info.path
    return info
  } catch (error) {
    throw error instanceof WorktreeError ? new UsageError(error.message) : error
  }
}

/** The one-shot form: says where the run happens, then (after it) what became of the worktree. */
export const printWorktreeStart = (info: WorktreeInfo, locale: Locale): string =>
  `${startedNotices(info, locale).join('\n')}\n`

export async function printWorktreeEnd(info: WorktreeInfo, locale: Locale): Promise<string> {
  return `${outcomeLine(await cleanupWorktree(info), locale)}\n`
}
