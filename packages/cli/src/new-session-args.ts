import { UsageError } from './errors.js'
import type { ParsedArgs } from './types.js'
import { takeWorktreeFlag } from './worktree-args.js'

/** Most `--add-dir` directories one session may carry; the daemon enforces the same bound. */
export const MAX_ADD_DIRS = 8

/**
 * Reads the flags that shape a new session out of `argv` before the main loop sees them:
 * `--worktree[=name]` and the repeatable `--add-dir <dir>` / `--add-dir=<dir>`. Everything after `--`
 * is data and passes through. The directories are stored as typed; resolveAddDirs makes them absolute.
 */
export function takeNewSessionFlags(p: ParsedArgs, argv: string[]): string[] {
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (takeWorktreeFlag(p, a)) continue
    if (a !== '--add-dir' && !a.startsWith('--add-dir=')) {
      rest.push(a)
      continue
    }
    if (p.command !== undefined)
      throw new UsageError('--add-dir starts a new session: use it without a command')
    const value = a === '--add-dir' ? argv[++i] : a.slice('--add-dir='.length)
    if (value === undefined || value === '' || (value.startsWith('-') && a === '--add-dir'))
      throw new UsageError('--add-dir needs a directory')
    p.addDir = [...(p.addDir ?? []), value]
    if (p.addDir.length > MAX_ADD_DIRS)
      throw new UsageError(`--add-dir takes at most ${MAX_ADD_DIRS} directories`)
  }
  return rest
}
