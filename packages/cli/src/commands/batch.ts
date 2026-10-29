import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { UsageError } from '../errors.js'

export const BATCH_USAGE = [
  'agh batch start <dir> --prompt <text> [--budget <credits>] [--item-budget <credits>] [--schema <file>]',
  '  [--concurrency <1-8>] [--item-timeout <60-3600 sec>] [--max-edge <256-1456>] [--out <folder>] [--ext txt,png] [--cwd <dir>] [--profile <name>]',
  'agh batch status <id> [--watch] | follow <id> | results <id> | resume <id> | cancel <id> | list',
  'agh batch export <id> --out <folder> [--json]',
  'Effects accept --operation <id>; start also accepts --id <batchId> for an exact native-approval retry.',
  'Approval-required or running native operations return exit code 3; unknown effects are never replayed.',
  'All commands accept --json, --cwd and --profile. Work continues in the backend after the CLI closes.',
].join('\n')
type Verb = 'start' | 'status' | 'follow' | 'results' | 'resume' | 'cancel' | 'list' | 'export' | 'help'
export type BatchArgs = {
  verb: Verb
  target?: string
  cwd?: string
  profile?: string
  json: boolean
  watch: boolean
  options: Record<string, string>
}
const stringFlags = [
  'prompt',
  'prompt-file',
  'budget',
  'item-budget',
  'schema',
  'concurrency',
  'item-timeout',
  'max-edge',
  'ext',
  'cwd',
  'profile',
  'out',
  'id',
  'operation',
]
const idPattern = /^b[0-9a-f]{12}$/u
export function parseBatchArgs(rest: readonly string[]): BatchArgs {
  let values: Record<string, string[] | boolean | undefined>, positionals: string[]
  try {
    const parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: {
        ...Object.fromEntries(stringFlags.map((name) => [name, { type: 'string' as const, multiple: true }])),
        json: { type: 'boolean' },
        watch: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch {
    throw new UsageError(BATCH_USAGE)
  }
  if (values.help) return { verb: 'help', json: false, watch: false, options: {} }
  const [verb, target, extra] = positionals
  if (
    !verb ||
    !['start', 'status', 'follow', 'results', 'resume', 'cancel', 'list', 'export'].includes(verb) ||
    extra ||
    (verb === 'list') !== (target === undefined) ||
    (target !== undefined && verb !== 'start' && !idPattern.test(target))
  )
    throw new UsageError(BATCH_USAGE)
  const options: Record<string, string> = {}
  for (const key of stringFlags) {
    const v = values[key]
    if (v === undefined) continue
    if (!Array.isArray(v) || v.length !== 1 || !v[0]) throw new UsageError(`duplicate or empty --${key}`)
    options[key] = v[0]
  }
  if (options.id && (verb !== 'start' || !idPattern.test(options.id)))
    throw new UsageError('--id requires start and a batch id')
  if (
    options.operation &&
    (!['start', 'resume', 'cancel', 'export'].includes(verb) ||
      !/^[A-Za-z0-9:._-]{1,128}$/u.test(options.operation))
  )
    throw new UsageError('invalid --operation')
  if (values.watch && verb !== 'status') throw new UsageError('--watch requires status')
  if (verb === 'start') {
    if ((options.prompt === undefined) === (options['prompt-file'] === undefined))
      throw new UsageError(BATCH_USAGE)
    for (const key of ['budget', 'item-budget']) if (options[key] !== undefined) positive(options[key]!, key)
    whole(options.concurrency, 4, 1, 8)
    whole(options['item-timeout'], 600, 60, 3600)
    whole(options['max-edge'], 1456, 256, 1456)
  } else {
    for (const key of Object.keys(options))
      if (!['cwd', 'profile', 'operation', ...(verb === 'export' ? ['out'] : [])].includes(key))
        throw new UsageError(`--${key} requires start`)
    if (verb === 'export' && !options.out) throw new UsageError('--out is required')
  }
  const { cwd, profile } = options
  delete options.cwd
  delete options.profile
  return {
    verb: verb as Verb,
    ...(target ? { target } : {}),
    ...(cwd ? { cwd } : {}),
    ...(profile ? { profile } : {}),
    json: values.json === true,
    watch: values.watch === true || verb === 'follow',
    options,
  }
}
function positive(value: string, flag: string): number {
  if (
    !/^\d+(?:\.\d+)?$/u.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0.000001 ||
    Number(value) > Number.MAX_SAFE_INTEGER
  )
    throw new UsageError(`--${flag} requires a positive safe number`)
  return Number(value)
}
function whole(value: string | undefined, fallback: number, low: number, high: number) {
  if (value === undefined) return fallback
  if (
    !/^\d+$/u.test(value) ||
    !Number.isInteger(Number(value)) ||
    Number(value) < low ||
    Number(value) > high
  )
    throw new UsageError(`expected a whole number from ${low} to ${high}`)
  return Number(value)
}
async function boundedFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) throw new UsageError('expected a regular input file')
    const bytes = Buffer.alloc(64 * 1024 + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null)
      if (!result.bytesRead) break
      offset += result.bytesRead
    }
    if (offset > 64 * 1024) throw new UsageError('input exceeds 64 KiB')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await handle.close()
  }
}
/** CLI transport only. The backend owns all enumeration, budgets, state and execution decisions. */
export interface BatchClient {
  call(verb: string, input: Record<string, unknown>, options?: { operationId?: string }): Promise<unknown>
  close(): Promise<void>
}
export type BatchIo = {
  cwd: string
  write(text: string): void
  connect(input: { cwd: string; profile?: string }): Promise<BatchClient>
  signal?: AbortSignal
  sleep?(ms: number, signal?: AbortSignal): Promise<void>
}
function status(value: unknown): string {
  if (value === null || typeof value !== 'object' || !('status' in value) || typeof value.status !== 'string')
    throw new Error('Invalid batch status response')
  return value.status
}
const safe = (s: string) => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
export async function batchCommand(rest: readonly string[], io: BatchIo): Promise<number> {
  const command = parseBatchArgs(rest)
  if (command.verb === 'help') {
    io.write(`${BATCH_USAGE}\n`)
    return 0
  }
  const cwd = resolve(io.cwd, command.cwd ?? '.')
  let payload: Record<string, unknown> = command.target ? { id: command.target } : {}
  if (command.verb === 'start') {
    const o = command.options
    const prompt = o.prompt ?? (await boundedFile(resolve(cwd, o['prompt-file']!)))
    if (!prompt || Buffer.byteLength(prompt) > 16_384) throw new UsageError('prompt must be 1–16384 bytes')
    let schema: unknown
    if (o.schema) {
      try {
        schema = JSON.parse(await boundedFile(resolve(cwd, o.schema)))
      } catch {
        throw new UsageError('schema must be a JSON file of at most 64 KiB')
      }
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema))
        throw new UsageError('schema must be an object')
    }
    const extensions = o.ext
      ?.split(',')
      .map((s) => s.trim().toLowerCase().replace(/^\./u, ''))
      .filter(Boolean)
    if (extensions && (extensions.length > 32 || extensions.some((s) => !/^[a-z0-9]{1,10}$/u.test(s))))
      throw new UsageError('invalid --ext')
    payload = {
      id: o.id ?? `b${randomBytes(6).toString('hex')}`,
      dir: command.target,
      workspaceRoot: cwd,
      spec: {
        prompt,
        budget: o.budget ? positive(o.budget, 'budget') : Number.MAX_SAFE_INTEGER,
        itemBudget: o['item-budget']
          ? positive(o['item-budget'], 'item-budget')
          : (o.budget ? positive(o.budget, 'budget') : Number.MAX_SAFE_INTEGER) /
            whole(o.concurrency, 4, 1, 8),
        concurrency: whole(o.concurrency, 4, 1, 8),
        itemTimeoutMs: whole(o['item-timeout'], 600, 60, 3600) * 1000,
        maxEdge: whole(o['max-edge'], 1456, 256, 1456),
        ...(o.out ? { out: o.out } : {}),
        maxRepairs: 1,
        failureLimit: 5,
        ...(schema !== undefined ? { schema } : {}),
      },
      ...(extensions ? { extensions } : {}),
    }
  }
  if (command.verb === 'export') payload.out = command.options.out
  io.signal?.throwIfAborted()
  const client = await io.connect({ cwd, ...(command.profile ? { profile: command.profile } : {}) })
  try {
    const cursors = new Set<string>()
    for (;;) {
      io.signal?.throwIfAborted()
      const result = await client.call(
        command.verb === 'follow' ? 'status' : command.verb,
        payload,
        command.options.operation ? { operationId: command.options.operation } : undefined,
      )
      io.write(`${command.json ? JSON.stringify(result) : safe(JSON.stringify(result))}\n`)
      if (result && typeof result === 'object' && 'operation' in result) {
        const operation = result.operation
        if (!operation || typeof operation !== 'object' || !('state' in operation))
          throw new Error('Invalid batch operation response')
        return ['approval-required', 'running'].includes(String(operation.state)) ? 3 : 1
      }
      if (
        command.verb === 'list' &&
        result !== null &&
        typeof result === 'object' &&
        'nextCursor' in result
      ) {
        const cursor = result.nextCursor
        if (
          typeof cursor !== 'string' ||
          !cursor ||
          cursor.length > 2048 ||
          cursors.has(cursor) ||
          cursors.size >= 10_000
        )
          throw new Error('Invalid batch list cursor')
        cursors.add(cursor)
        payload = { cursor }
        continue
      }
      if (
        command.verb === 'results' &&
        result !== null &&
        typeof result === 'object' &&
        'nextOffset' in result
      ) {
        const next = result.nextOffset
        if (
          typeof next !== 'number' ||
          !Number.isSafeInteger(next) ||
          next <= Number(payload.offset ?? 0) ||
          next > 100_000
        )
          throw new Error('Invalid batch results cursor')
        payload = { ...payload, offset: next }
        continue
      }
      if (!command.watch)
        return ['status', 'resume', 'cancel'].includes(command.verb) &&
          !['running', 'completed'].includes(status(result))
          ? 1
          : 0
      const state = status(result)
      if (state !== 'running') return state === 'completed' ? 0 : 1
      if (io.sleep) await io.sleep(5000, io.signal)
      else {
        const { setTimeout } = await import('node:timers/promises')
        await setTimeout(5000, undefined, { ...(io.signal ? { signal: io.signal } : {}) })
      }
    }
  } finally {
    await client.close()
  }
}
