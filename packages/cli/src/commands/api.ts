import { readFileSync } from 'node:fs'
import {
  describeValidationErrors,
  METHOD_TIERS,
  METHODS,
  type MethodName,
  validateMethod,
} from '@agnes/protocol'
import { JsonRpcError, type NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }

const PREFIX = '_agnes/v1/'

/**
 * Method names `agh api` never sends, first match wins. These need the SDK's commandId and pending
 * journal (submit class), or a live event stream or subscription (attach class), which one
 * request/response call cannot honour; `agh queue` and the subcommands cover the supported ones.
 * Matched on dotted segments so a new method such as `submit.retry` or `session.subscribe` is refused
 * by default while admin calls like `plugins.candidates.submit` stay callable; api.test.ts pins the exact refused set so a change is a reviewed one.
 */
export const API_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^(submit(\.|$)|session\.(.+\.)?(control|fork|undo)$)/,
    'it is a command that needs a command id and the pending journal; use agh queue or the matching subcommand',
  ],
  [
    /(^|\.)(attach|detach|subscribe|unsubscribe|stream|join|leave)(\.|$)/,
    'it attaches to or subscribes to a live session; one request cannot hold that stream',
  ],
]

/** Why `agh api` will not send this method, or undefined when it may. */
export function apiRefusal(method: string): string | undefined {
  if (!method.startsWith(PREFIX))
    return 'only _agnes/v1 methods can be called; session lifecycle calls belong to agh itself'
  const name = method.slice(PREFIX.length)
  const spec = Object.hasOwn(METHODS, method) ? METHODS[method as MethodName] : undefined
  if (spec && (spec.kind !== 'request' || spec.direction !== 'c2s'))
    return 'it is a notification or a server-to-client call'
  return API_REFUSALS.find(([pattern]) => pattern.test(name))?.[1]
}

/** Every method a client may call, with its tier, in name order. */
export function callableMethods(): Array<{ method: string; tier: string }> {
  return (Object.keys(METHODS) as MethodName[])
    .filter((m) => apiRefusal(m) === undefined)
    .sort()
    .map((method) => ({ method, tier: METHOD_TIERS[method] }))
}

export function apiHelp(): string {
  const rows = callableMethods().map((m) => `  ${m.method.slice(PREFIX.length).padEnd(38)} ${m.tier}`)
  return [
    'Usage: agh api <method> [--params <json|->] [--json]',
    "Call one protocol method on the daemon with this CLI's own connection; it adds no permission. <method> is a name from the list below, with or without the _agnes/v1/ prefix. --params is the JSON params object (- reads stdin; default {}) and is checked against the protocol schema before anything is sent. The result is printed as JSON on stdout (--json: one line); a daemon refusal goes to stderr and exits 1. admin methods need an admin connection; without one the daemon refuses and its answer is shown as it comes. Streaming, attach and command-class methods are refused: use agh queue or the matching subcommand.",
    'Callable methods (tier):',
    ...rows,
  ].join('\n')
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    row = next
  }
  return row[b.length] ?? 0
}

/** The closest known method names to a mistyped one. */
export function closestMethods(input: string, limit = 3): string[] {
  const want = input.replace(PREFIX, '').toLowerCase()
  return Object.keys(METHODS)
    .map((m) => m.slice(PREFIX.length))
    .map((name) => ({
      name,
      d: distance(want, name.toLowerCase()) - (name.toLowerCase().includes(want) ? 99 : 0),
    }))
    .sort((x, y) => x.d - y.d || x.name.localeCompare(y.name))
    .slice(0, limit)
    .map((x) => x.name)
}

function readParams(source: string | undefined): unknown {
  if (source === undefined) return {}
  let text = source
  if (source === '-') {
    try {
      text = readFileSync(0, 'utf8')
    } catch {
      throw new UsageError('cannot read --params from stdin')
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new UsageError('--params is not valid JSON')
  }
}

/**
 * `agh api <method> [--params <json|->]`: one protocol call over the connection the CLI already has.
 * The method must be in the protocol table and callable (see API_REFUSALS); params are validated
 * against the protocol schema before anything is sent. Authorization stays the daemon's.
 */
export async function apiCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const [input, ...extra] = p.positional
  if (!input || extra.length > 0) throw new UsageError('api expects <method> [--params <json|->]')
  const method = input.includes('/') || input.startsWith('_agnes') ? input : `${PREFIX}${input}`
  if (!Object.hasOwn(METHODS, method)) {
    const near = closestMethods(input)
    throw new UsageError(`unknown method ${oneLine(input)}; closest: ${near.join(', ')}`)
  }
  const refusal = apiRefusal(method)
  if (refusal) throw new UsageError(`${oneLine(input)} is not callable from agh api: ${refusal}`)
  const params = readParams(p.params)
  const checked = validateMethod(method as MethodName, 'params', params)
  if (!checked.ok)
    throw new UsageError(`params do not match ${oneLine(input)}: ${describeValidationErrors(checked.errors)}`)
  try {
    const result = await client.call(method, params)
    io.stdout.write(`${JSON.stringify(result ?? null, null, p.json ? undefined : 2)}\n`)
    return ExitCode.OK
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error
    io.stderr.write(`error: ${oneLine(error.data.code)}: ${oneLine(error.rpc.message)}\n`)
    return ExitCode.ERROR
  }
}
