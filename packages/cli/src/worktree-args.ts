import { UsageError } from './errors.js'
import type { ParsedArgs } from './types.js'

/**
 * Reads `--worktree` (auto name) or `--worktree=name` into `p`; a bare word after the flag stays the prompt.
 * Returns whether `arg` was the flag. A subcommand other than `resume` has no session to start.
 */
export function takeWorktreeFlag(p: ParsedArgs, arg: string): boolean {
  if (arg !== '--worktree' && !arg.startsWith('--worktree=')) return false
  if (p.command !== undefined)
    throw new UsageError('--worktree starts a new session: use it without a command')
  p.worktree = arg.slice('--worktree='.length)
  return true
}
