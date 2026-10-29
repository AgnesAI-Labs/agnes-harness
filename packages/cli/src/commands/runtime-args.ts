import { parseArgs } from 'node:util'
import { UsageError } from '../errors.js'

export const RUNTIME_USAGE =
  'agh runtime reconcile <resource> --extension <row-id> [--operation <id>] [--answer allow|reject] [--profile <name>] [--json]'
/** Thin operator surface. Identity checks, grants, decision subjects and recovery stay in the Host. */
export function parseRuntimeArgs(rest: readonly string[]) {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: {
        extension: { type: 'string' },
        operation: { type: 'string' },
        answer: { type: 'string' },
        profile: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    })
  } catch {
    throw new UsageError(RUNTIME_USAGE)
  }
  if (args.values.help) {
    return args
  }
  const [verb, resource, extra] = args.positionals
  const { extension, operation, answer, profile } = args.values
  if (
    verb !== 'reconcile' ||
    !resource ||
    !/^[a-zA-Z0-9._-]{1,128}$/u.test(resource) ||
    extra ||
    typeof extension !== 'string' ||
    !extension.startsWith('ext:') ||
    (operation !== undefined &&
      (typeof operation !== 'string' || !/^[a-zA-Z0-9:._-]{1,128}$/u.test(operation))) ||
    (answer !== undefined && (!operation || !['allow', 'reject'].includes(String(answer)))) ||
    (profile !== undefined && typeof profile !== 'string')
  )
    throw new UsageError(RUNTIME_USAGE)
  return args
}
