import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
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
type Verb = 'start' | 'status' | 'results' | 'cancel' | 'list'
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
  '          [--concurrency <1-8>] [--max-edge <256-1456>] [--budget <credits>] [--out <dir>] [--item-timeout <sec>]',
  'agh batch status <id> [--watch] | results <id> | cancel <id> | list      [--cwd <dir>] [--profile <p>] [--json]',
].join('\n')

export function parseBatchArgs(rest: readonly string[]): BatchCommand {
  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: {
        ...Object.fromEntries(OPTION_NAMES.map((name) => [name, { type: 'string' as const }])),
        cwd: { type: 'string' },
        profile: { type: 'string' },
        json: { type: 'boolean' },
        watch: { type: 'boolean' },
      },
    }) as typeof parsed
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)}\n${BATCH_USAGE}`)
  }
  const [verb, target, ...extra] = parsed.positionals
  if (!verb || !VERBS.includes(verb as Verb) || extra.length > 0) throw new UsageError(BATCH_USAGE)
  if ((verb === 'list') !== (target === undefined)) throw new UsageError(BATCH_USAGE)
  const v = parsed.values
  if (verb === 'start' && (v.prompt === undefined) === (v['prompt-file'] === undefined))
    throw new UsageError(`agh batch start needs exactly one of --prompt or --prompt-file\n${BATCH_USAGE}`)
  const options = Object.fromEntries(
    OPTION_NAMES.filter((name) => typeof v[name] === 'string').map((name) => [name, v[name] as string]),
  ) as Partial<Record<OptionName, string>>
  return {
    verb: verb as Verb,
    ...(target !== undefined ? { target } : {}),
    ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {}),
    ...(typeof v.profile === 'string' ? { profile: v.profile } : {}),
    json: v.json === true,
    watch: v.watch === true,
    options,
  }
}

const whole = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value)) throw new UsageError(`--${name} expects a whole number`)
  return Number(value)
}

async function specFrom(command: BatchCommand, cwd: string): Promise<BatchSpec> {
  const o = command.options
  const prompt = o.prompt ?? (await readFile(resolve(cwd, o['prompt-file'] as string), 'utf8'))
  let schema: Record<string, unknown> | undefined
  if (o.schema !== undefined) {
    try {
      schema = JSON.parse(await readFile(resolve(cwd, o.schema), 'utf8')) as Record<string, unknown>
    } catch {
      throw new UsageError(`--schema ${o.schema} is not a readable JSON file`)
    }
  }
  if (o.budget !== undefined && !/^\d+(\.\d+)?$/u.test(o.budget))
    throw new UsageError('--budget expects a positive number')
  const concurrency = whole('concurrency', o.concurrency)
  const maxEdge = whole('max-edge', o['max-edge'])
  const itemTimeoutSec = whole('item-timeout', o['item-timeout'])
  return {
    dir: command.target as string,
    prompt,
    ...(schema !== undefined ? { schema } : {}),
    ...(o.ext !== undefined
      ? {
          ext: o.ext
            .split(',')
            .map((ext) => ext.trim().toLowerCase().replace(/^\./u, ''))
            .filter(Boolean),
        }
      : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(maxEdge !== undefined ? { maxEdge } : {}),
    ...(o.budget !== undefined ? { budgetCredits: Number(o.budget) } : {}),
    ...(o.out !== undefined ? { outDir: o.out } : {}),
    ...(itemTimeoutSec !== undefined ? { itemTimeoutSec } : {}),
  }
}

const line = (s: BatchStatus): string =>
  `${s.batchId}  ${s.status}  ${s.counts.done}/${s.counts.total} done, ${s.counts.failed + s.counts.invalid} failed, ${s.spentCredits} credits  ${s.dir}`

function render(s: BatchStatus): string {
  const c = s.counts
  return [
    `Batch ${s.batchId}: ${s.status}${s.reason ? ` (${s.reason})` : ''}`,
    `Folder ${s.dir}: ${c.total} files - done ${c.done}, running ${c.running}, pending ${c.pending}, invalid ${c.invalid}, failed ${c.failed}, skipped ${c.skipped}, cancelled ${c.cancelled}`,
    `Credits spent: ${s.spentCredits}${s.budgetCredits !== undefined ? ` of ${s.budgetCredits}` : ''}`,
    `Results folder: ${s.outDir}`,
    ...(s.files ? [`Files: ${s.files.join(', ')}`] : []),
    ...(s.summary ? ['', s.summary] : []),
  ].join('\n')
}

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
      case 'start': {
        const spec = await specFrom(command, io.cwd)
        await client.workspace.add(io.cwd)
        show(await client.call<BatchStatus>('_agnes/v1/batch.start', { cwd: io.cwd, spec }))
        return 0
      }
      case 'status': {
        for (;;) {
          const s = await client.call<BatchStatus>('_agnes/v1/batch.status', { batchId: command.target })
          const finished = s.status !== 'running'
          show(s, command.watch && !finished)
          if (!command.watch || finished) return s.status === 'failed' ? 1 : 0
          await sleep(5000)
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
    if (error instanceof UsageError) throw error
    const missing = (error as { code?: unknown }).code === -32601
    io.error(
      `agh batch: ${error instanceof Error ? error.message : String(error)}${missing ? ' (batch processing needs the AGH daemon: agh daemon start)' : ''}\n`,
    )
    return 1
  }
}
