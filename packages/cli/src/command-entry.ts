import { resolve } from 'node:path'
import { parseArgs } from './args.js'
import { parseBatchArgs } from './commands/batch.js'
import type { ParsedArgs } from './types.js'

export { resolveMode } from './args.js'
export { dispatchBatchCli } from './commands/batch-runtime.js'

/** Validate forwarded identity options before home setup; keep cwd relative to the caller. */
export function prepareCommandArgs(argv: string[], cwd: string): ParsedArgs {
  let parsed = parseArgs(argv)
  if (parsed.command === 'batch' && !parsed.help) {
    const batch = parseBatchArgs(parsed.rest)
    parsed = {
      ...parsed,
      ...(batch.cwd ? { cwd: batch.cwd } : {}),
      ...(batch.profile ? { profile: batch.profile } : {}),
    }
  }
  return parsed.cwd === undefined ? parsed : { ...parsed, cwd: resolve(cwd, parsed.cwd) }
}
