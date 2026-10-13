import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { escapeControl } from '@agnes/cli-tui'
import type { BatchList, BatchSpec, BatchStatus } from '@agnes/protocol'
import { UsageError } from '../errors.js'

export type BatchClient = Readonly<{
  call<T>(method: string, params: unknown): Promise<T>
  workspace: Readonly<{ add(path: string): Promise<unknown> }>
}>
export type BatchIo = Readonly<{
  cwd: string
  write(text: string): void
  error(text: string): void
  sleep?: (ms: number) => Promise<void>
}>
type Verb = 'start' | 'status' | 'results' | 'cancel' | 'list' | 'help'
const VERBS: readonly Verb[] = ['start', 'status', 'results', 'cancel', 'list']
const OPTION_NAMES = [
  'prompt',
  'prompt-file',
  'schema',
  'ext',
  'concurrency',
  'max-edge',
  'budget',
  'out',
  'item-timeout',
] as const
type OptionName = (typeof OPTION_NAMES)[number]
export type BatchCommand = Readonly<{
  verb: Verb
  target?: string
  cwd?: string
  profile?: string
  json: boolean
  watch: boolean
  options: Readonly<Partial<Record<OptionName, string>>>
}>

export const BATCH_USAGE = [
  'agh batch start <dir> (--prompt <text> | --prompt-file <file>) [--schema <file.json>] [--ext jpg,png]',
  '          [--concurrency <1-8>] [--max-edge <256-1456>] [--budget <credits>] [--out <dir>] [--item-timeout <60-3600 sec>]',
  'agh batch status <id> [--watch] | results <id> | cancel <id> | list      [--cwd <dir>] [--profile <p>] [--json]',
  'agh batch --help',
  'Exit status of `status`: 0 when the batch completed or is still running; 1 when it failed, ran out of budget or was',
  'cancelled; 2 for a usage error. With --watch it returns only at a final state, so 0 means the batch completed.',
].join('\n')

// The same ranges as the protocol's BatchSpec and BatchIdParams. They are repeated here so a bad value is a
// usage error before any daemon is started; the daemon still validates everything it receives.
const RANGES = {
  concurrency: [1, 8],
  'max-edge': [256, 1456],
  'item-timeout': [60, 3600],
} as const
const MIN_BUDGET = 0.000001
const MAX_PROMPT_CHARS = 16384
const BATCH_ID = /^b[0-9a-f]{12}$/u
const EXT = /^[a-z0-9]{1,10}$/u
const MAX_EXTENSIONS = 32
/** A prompt or schema file is read at most this far; a bigger file is refused instead of slurped. */
const MAX_INPUT_FILE_BYTES = 64 * 1024
const MAX_TRANSIENT_ERRORS = 3
const POLL_MS = 5000

export function parseBatchArgs(rest: readonly string[]): BatchCommand {
  let parsed: { values: Record<string, Array<string> | boolean | undefined>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: {
        ...Object.fromEntries(
          OPTION_NAMES.map((name) => [name, { type: 'string' as const, multiple: true }]),
        ),
        cwd: { type: 'string', multiple: true },
        profile: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        watch: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }) as typeof parsed
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${BATCH_USAGE}`)
  }
  const v = parsed.values
  if (v.help === true) return { verb: 'help', json: false, watch: false, options: {} }
  const single = (name: string): string | undefined => {
    const values = v[name] as string[] | undefined
    if (values !== undefined && values.length > 1) throw new UsageError(`--${name} was given more than once`)
    return values?.[0]
  }
  const [verb, target, ...extra] = parsed.positionals
  if (!verb || !VERBS.includes(verb as Verb) || extra.length > 0) throw new UsageError(BATCH_USAGE)
  if ((verb === 'list') !== (target === undefined)) throw new UsageError(BATCH_USAGE)
  if (target !== undefined && verb !== 'start' && !BATCH_ID.test(target))
    throw new UsageError(
      `${JSON.stringify(escapeControl(target))} is not a batch id (b followed by 12 hex digits)`,
    )
  const options = Object.fromEntries(
    OPTION_NAMES.filter((name) => v[name] !== undefined).map((name) => [name, single(name) as string]),
  ) as Partial<Record<OptionName, string>>
  if (verb !== 'start') {
    const stray = Object.keys(options)[0]
    if (stray !== undefined)
      throw new UsageError(`--${stray} only belongs to agh batch start\n${BATCH_USAGE}`)
  }
  if (v.watch === true && verb !== 'status')
    throw new UsageError(`--watch only belongs to agh batch status\n${BATCH_USAGE}`)
  if (verb === 'start' && (options.prompt === undefined) === (options['prompt-file'] === undefined))
    throw new UsageError(`agh batch start needs exactly one of --prompt or --prompt-file\n${BATCH_USAGE}`)
  const cwd = single('cwd')
  const profile = single('profile')
  return {
    verb: verb as Verb,
    ...(target !== undefined ? { target } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(profile !== undefined ? { profile } : {}),
    json: v.json === true,
    watch: v.watch === true,
    options,
  }
}

const whole = (name: keyof typeof RANGES, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  const [low, high] = RANGES[name]
  if (!/^\d+$/u.test(value) || Number(value) < low || Number(value) > high)
    throw new UsageError(`--${name} expects a whole number from ${low} to ${high}`)
  return Number(value)
}

/** Reads a small input file; a missing, unreadable or oversized file is a usage error naming the flag. */
async function readInput(cwd: string, flag: string, name: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(resolve(cwd, name), 'r')
    const buffer = Buffer.alloc(MAX_INPUT_FILE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_INPUT_FILE_BYTES)
      throw new UsageError(`${flag} ${name} is larger than ${MAX_INPUT_FILE_BYTES / 1024} KiB`)
    return buffer.toString('utf8', 0, bytesRead)
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError(`${flag} ${name} is not a readable file`)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function specFrom(command: BatchCommand, cwd: string): Promise<BatchSpec> {
  const o = command.options
  const prompt = o.prompt ?? (await readInput(cwd, '--prompt-file', o['prompt-file'] as string))
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS)
    throw new UsageError(`the prompt must be 1 to ${MAX_PROMPT_CHARS} characters`)
  let schema: BatchSpec['schema'] | undefined
  if (o.schema !== undefined) {
    const text = await readInput(cwd, '--schema', o.schema)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new UsageError(`--schema ${o.schema} is not a JSON file`)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new UsageError(`--schema ${o.schema} must hold a JSON object`)
    schema = value as BatchSpec['schema']
  }
  if (o.budget !== undefined && (!/^\d+(\.\d+)?$/u.test(o.budget) || Number(o.budget) < MIN_BUDGET))
    throw new UsageError(`--budget expects a positive number of credits (at least ${MIN_BUDGET})`)
  const concurrency = whole('concurrency', o.concurrency)
  const maxEdge = whole('max-edge', o['max-edge'])
  const itemTimeoutSec = whole('item-timeout', o['item-timeout'])
  let ext: string[] | undefined
  if (o.ext !== undefined) {
    ext = o.ext
      .split(',')
      .map((e) => e.trim().toLowerCase().replace(/^\./u, ''))
      .filter(Boolean)
    if (ext.length === 0 || ext.length > MAX_EXTENSIONS || ext.some((e) => !EXT.test(e)))
      throw new UsageError('--ext expects up to 32 comma-separated extensions such as jpg,png')
  }
  if (command.target === '' || o.out === '') throw new UsageError('the folder and --out must not be empty')
  return {
    dir: command.target as string,
    prompt,
    ...(schema !== undefined ? { schema } : {}),
    ...(ext !== undefined ? { ext } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(maxEdge !== undefined ? { maxEdge } : {}),
    ...(o.budget !== undefined ? { budgetCredits: Number(o.budget) } : {}),
    ...(o.out !== undefined ? { outDir: o.out } : {}),
    ...(itemTimeoutSec !== undefined ? { itemTimeoutSec } : {}),
  }
}

// Everything below the daemon's answer is text a model or a file name can shape: one inert line each,
// except the summary, which keeps its line breaks and loses every other control character.
const inert = (text: string): string => escapeControl(text).replace(/\n/gu, ' ')

const line = (s: BatchStatus): string =>
  `${inert(s.batchId)}  ${inert(s.status)}  ${s.counts.done}/${s.counts.total} done, ${s.counts.failed + s.counts.invalid} failed, ${s.spentCredits} credits  ${inert(s.dir)}`

function render(s: BatchStatus): string {
  const c = s.counts
  return [
    `Batch ${inert(s.batchId)}: ${inert(s.status)}${s.reason ? ` (${inert(s.reason)})` : ''}`,
    `Folder ${inert(s.dir)}: ${c.total} files - done ${c.done}, running ${c.running}, pending ${c.pending}, invalid ${c.invalid}, failed ${c.failed}, skipped ${c.skipped}, cancelled ${c.cancelled}`,
    `Credits spent: ${s.spentCredits}${s.budgetCredits !== undefined ? ` of ${s.budgetCredits}` : ''}`,
    `Results folder: ${inert(s.outDir)}`,
    ...(s.files ? [`Files: ${s.files.map(inert).join(', ')}`] : []),
    ...(s.summary ? ['', escapeControl(s.summary)] : []),
  ].join('\n')
}

const kindOf = (error: unknown): unknown => (error as { kind?: unknown } | null)?.kind
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code
const isRpcFailure = (error: unknown): boolean =>
  kindOf(error) === 'json-rpc' || typeof codeOf(error) === 'number'
const isTransportFailure = (error: unknown): boolean => kindOf(error) === 'transport-closed'
/** A change worth a line while watching: the state, the counts or the spend moved. */
const progress = (s: BatchStatus): string => JSON.stringify([s.status, s.counts, s.spentCredits])

export async function runBatchCommand(
  command: BatchCommand,
  client: BatchClient,
  io: BatchIo,
): Promise<number> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const show = (s: BatchStatus, compact = false): void =>
    io.write(`${command.json ? JSON.stringify(s) : compact ? line(s) : render(s)}\n`)
  try {
    switch (command.verb) {
      case 'help':
        io.write(`${BATCH_USAGE}\n`)
        return 0
      case 'start': {
        const spec = await specFrom(command, io.cwd)
        // A start the daemon then refuses leaves the folder registered as a workspace; that is harmless.
        await client.workspace.add(io.cwd)
        show(await client.call<BatchStatus>('_agnes/v1/batch.start', { cwd: io.cwd, spec }))
        return 0
      }
      case 'status': {
        let last: string | undefined
        let transient = 0
        for (;;) {
          let s: BatchStatus
          try {
            s = await client.call<BatchStatus>('_agnes/v1/batch.status', { batchId: command.target })
          } catch (error) {
            // While watching, a daemon that restarts is waited for a few polls instead of ending the watch.
            if (!command.watch || !isTransportFailure(error) || transient >= MAX_TRANSIENT_ERRORS) throw error
            transient += 1
            io.error(
              `agh batch: lost the daemon connection, retrying (${transient}/${MAX_TRANSIENT_ERRORS})\n`,
            )
            await sleep(POLL_MS)
            continue
          }
          transient = 0
          const finished = s.status !== 'running'
          if (!command.watch || finished) {
            show(s)
            return finished && s.status !== 'completed' ? 1 : 0
          }
          const mark = progress(s)
          if (mark !== last) show(s, true)
          last = mark
          await sleep(POLL_MS)
        }
      }
      case 'results':
        show(
          await client.call<BatchStatus>('_agnes/v1/batch.status', { batchId: command.target, export: true }),
        )
        return 0
      case 'cancel':
        show(await client.call<BatchStatus>('_agnes/v1/batch.cancel', { batchId: command.target }))
        return 0
      case 'list': {
        const list = await client.call<BatchList>('_agnes/v1/batch.list', {})
        io.write(
          `${command.json ? JSON.stringify(list) : list.items.map(line).join('\n') || 'No batches.'}\n`,
        )
        return 0
      }
    }
  } catch (error) {
    // Only a refusal the daemon itself answered is reported here. A closed connection or anything
    // unexpected goes up to main, which has the safe wording for it.
    if (error instanceof UsageError || !isRpcFailure(error)) throw error
    const code = codeOf(error)
    // An older daemon lacks the methods; one without job tables (or not on its local socket) refuses them.
    const missing = code === -32601 || code === -32006
    // The daemon names its refusal (SEMANTIC_REJECTED) and says why in data.reason.
    const reason = (error as { data?: { reason?: unknown } }).data?.reason
    const message = typeof reason === 'string' ? reason : error instanceof Error ? error.message : ''
    io.error(
      `agh batch: ${inert(message).slice(0, 300) || `request refused (${String(code)})`}${missing ? ' (batch processing needs the AGH daemon: agh daemon start)' : ''}\n`,
    )
    return 1
  }
}
