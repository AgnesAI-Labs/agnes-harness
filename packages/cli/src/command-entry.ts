import { resolve } from 'node:path'
import { parseArgs } from './args.js'
import type { DefaultBootDeps } from './boot/default.js'
import { parseBatchArgs } from './commands/batch.js'
import { parseRuntimeArgs } from './commands/runtime-args.js'
import type { ParsedArgs } from './types.js'

export { resolveMode } from './args.js'
export function isProfileCommand(command: ParsedArgs['command']) {
  return command === 'batch' || command === 'runtime'
}
export async function dispatchProfileCli(
  parsed: ParsedArgs,
  io: { cwd: string; stdout: NodeJS.WritableStream; signals?: NodeJS.EventEmitter },
  deps: DefaultBootDeps,
  useEmbedded: boolean,
) {
  // Loaded when the command runs: both pull in the boot path and the Host, which `--help` never needs.
  if (parsed.command === 'batch') {
    const { dispatchBatchCli } = await import('./commands/batch-runtime.js')
    return dispatchBatchCli(parsed, io, deps, useEmbedded)
  }
  const [{ runtimeCommand }, { bootDefault }] = await Promise.all([
    import('./commands/runtime.js'),
    import('./boot/default.js'),
  ])
  return runtimeCommand(parsed.rest, {
    write: (text) => {
      io.stdout.write(text)
    },
    connect: () => bootDefault(parsed, deps, { useEmbedded }),
  })
}

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
  if (parsed.command === 'runtime' && !parsed.help) {
    const runtime = parseRuntimeArgs(parsed.rest)
    if (typeof runtime.values.profile === 'string') parsed = { ...parsed, profile: runtime.values.profile }
  }
  return parsed.cwd === undefined ? parsed : { ...parsed, cwd: resolve(cwd, parsed.cwd) }
}
