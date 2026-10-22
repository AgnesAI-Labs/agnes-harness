import { UsageError } from './errors.js'
import type { ParsedArgs } from './types.js'

/**
 * `--safe-mode` and `--ignore-rules` change what one session loads. A shared daemon serves other
 * sessions with the same configuration, so they are honoured only by a private host (--ephemeral or
 * --standalone) that this client starts itself; an explicit --connect always reaches someone else's
 * host, even when --standalone is also given.
 */
export function refusePrivateHostFlags(p: ParsedArgs): void {
  if (!p.safeMode && !p.ignoreRules) return
  const name = p.safeMode ? '--safe-mode' : '--ignore-rules'
  if (p.command !== undefined && p.command !== 'resume')
    throw new UsageError(`${name} applies only to starting or resuming a session`)
  if (p.connect !== undefined || !(p.standalone || p.ephemeral))
    throw new UsageError(
      `${name} needs a private host: add --ephemeral or --standalone, and do not combine it with --connect or a shared daemon`,
    )
}
