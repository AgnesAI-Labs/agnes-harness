import { closestNames } from '@agnes/protocol/command-line'
import type { ParsedArgs } from './types.js'

// Flags the parser reads by hand ahead of its tables, so a suggestion can still name them.
const HAND_PARSED = ['--agent', '--loop', '--model', '--include', '--skip']

/**
 * `unknown flag --x`, plus `; did you mean --y?` when a long flag is close. Only a plainly shaped
 * name is echoed or matched: a short flag is one edit from every other, and the rest is untrusted.
 */
export function unknownFlagMessage(arg: string, known: readonly string[]): string {
  const name = arg.split('=', 1)[0] ?? ''
  const safe = /^(?:--[a-z][a-z0-9-]{0,63}|-[A-Za-z])$/.test(name) ? name : ''
  const near = safe.startsWith('--')
    ? closestNames(
        safe,
        [...known, ...HAND_PARSED].filter((flag) => flag.startsWith('--')),
      )[0]
    : undefined
  return `unknown flag${safe && ` ${safe}`}${near ? `; did you mean ${near}?` : ''}`
}

/**
 * A lone word one typo from a subcommand, as in `agh sesions`. It still runs as a prompt (a
 * one-word prompt is allowed), so the caller only says what it might have meant.
 */
export function mistypedCommand(p: ParsedArgs, commands: ReadonlySet<string>): string | undefined {
  const word = p.positional[0]
  if (
    p.command !== undefined ||
    p.print ||
    p.positional.length !== 1 ||
    !word ||
    !/^[a-z][a-z-]{1,31}$/.test(word)
  )
    return undefined
  return closestNames(word, commands)[0]
}
