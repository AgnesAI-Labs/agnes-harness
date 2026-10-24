import { UsageError } from './errors.js'
import type { ParsedArgs } from './types.js'

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const MAX_NAMES = 128

/** `a,b,c` into exact names. Anything the daemon would refuse later is refused here first, by flag. */
export function parseToolList(flag: string, value: string): string[] {
  const names = value.split(',').map((name) => name.trim())
  if (names.some((name) => !TOOL_NAME.test(name)))
    throw new UsageError(
      `${flag} expects comma-separated tool names (letters, digits, underscore; no wildcards)`,
    )
  const unique = [...new Set(names)]
  if (unique.length > MAX_NAMES) throw new UsageError(`${flag} names more than ${MAX_NAMES} tools`)
  return unique
}

/** `--tools` / `--disallowed-tools` and their value, recorded on the parsed arguments. */
export function readToolFlag(p: ParsedArgs, flag: string, value: string | undefined): void {
  if (value === undefined || (value.startsWith('-') && value !== '-'))
    throw new UsageError(`${flag} needs a value`)
  const key = flag === '--tools' ? 'allow' : 'deny'
  if (p.toolFilter?.[key]) throw new UsageError(`${flag} was given twice; list every tool in one value`)
  p.toolFilter = { ...p.toolFilter, [key]: parseToolList(flag, value) }
}

/** Everything but starting or resuming a session would drop the flag without a word, and a tool the user took away must stay off. */
export function refuseToolFilterElsewhere(p: ParsedArgs): void {
  if (p.toolFilter && !((p.command === undefined || p.command === 'resume') && p.mode !== 'acp'))
    throw new UsageError('--tools and --disallowed-tools apply only when starting or resuming a session')
}
