import { randomUUID } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runHeadless } from '@agnes/sdk'
import { parseArgs } from '../args.js'
import { installSignalLadder } from '../boot/signals.js'
import { ExitCode, exitCodeForReason, SIGNAL_EXIT_CODES, type SignalName, UsageError } from '../errors.js'
import type { Booted, ParsedArgs } from '../types.js'

export const RUN_USAGE =
  'agh run --bundle <package#id|path> --input <file|-> --json [--batch] [--profile <p>] [--preset <p>] [--loop <id>@<version>] [--model <slot>=<route>/<model>] [--cwd <dir>]'
export type RunArgs = {
  bundle: string
  input: string
  batch: boolean
  args: ParsedArgs
}
export function parseRunArgs(rest: string[]): RunArgs {
  let bundle: string | undefined
  let input: string | undefined
  let batch = false
  let json = false
  const common: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!
    if (seen.has(flag)) throw new UsageError(`duplicate ${flag}`)
    seen.add(flag)
    if (flag === '--batch') {
      batch = true
      continue
    }
    if (flag === '--json') {
      json = true
      continue
    }
    if (!['--bundle', '--input', '--profile', '--preset', '--loop', '--model', '--cwd'].includes(flag))
      throw new UsageError(`unknown run option ${flag}\n${RUN_USAGE}`)
    const value = rest[++index]
    if (!value || (value.startsWith('-') && !(flag === '--input' && value === '-')))
      throw new UsageError(`${flag} requires a value`)
    if (flag === '--bundle') bundle = value
    else if (flag === '--input') input = value
    else {
      common.push(flag, value)
    }
  }
  if (!bundle || !input || !json) throw new UsageError(RUN_USAGE)
  if (batch && input === '-') throw new UsageError('--batch needs an input folder')
  const args = parseArgs(common)
  args.standalone = true
  return { bundle, input, batch, args }
}
export type HeadlessRunBoot = {
  bundle: string
  args: ParsedArgs
  signal: AbortSignal
}
export type RunCommandDeps = {
  cwd: string
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream
  signals?: NodeJS.EventEmitter
  exit?: (code: number) => void
  boot(input: HeadlessRunBoot): Promise<Booted>
}
const MAX_INPUT = 4 * 1024 * 1024
async function readInput(path: string, stdin: RunCommandDeps['stdin'], signal: AbortSignal): Promise<string> {
  let bytes: Uint8Array
  if (path === '-') {
    if (stdin.isTTY) throw new UsageError('--input - requires piped stdin')
    const chunks: Buffer[] = []
    let length = 0
    const abort = () =>
      (stdin as NodeJS.ReadableStream & { destroy?: (error: Error) => void }).destroy?.(
        new Error('headless input aborted'),
      )
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      for await (const chunk of stdin) {
        signal.throwIfAborted()
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        length += buffer.length
        if (length > MAX_INPUT) throw new UsageError('headless input exceeds 4 MiB')
        chunks.push(buffer)
      }
      bytes = Buffer.concat(chunks)
    } finally {
      signal.removeEventListener('abort', abort)
    }
  } else {
    const file = await open(path, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > MAX_INPUT)
        throw new UsageError('headless input must be a file of at most 4 MiB')
      bytes = Buffer.alloc(info.size + 1)
      let bytesRead = 0
      while (bytesRead < bytes.length) {
        signal.throwIfAborted()
        const read = await file.read(bytes, bytesRead, bytes.length - bytesRead, null)
        if (!read.bytesRead) break
        bytesRead += read.bytesRead
      }
      if (bytesRead > info.size) throw new UsageError('headless input changed while reading')
      bytes = bytes.subarray(0, bytesRead)
    } finally {
      await file.close()
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(value)}\n`, (error?: Error | null) => (error ? reject(error) : resolve()))
  })
}
/** Sequential folder runs use fresh sessions and stop on a signal; every input gets its own result. */
export async function runCommand(rest: string[], deps: RunCommandDeps): Promise<number> {
  if (rest.length === 1 && ['--help', '-h'].includes(rest[0]!)) {
    deps.stdout.write(`${RUN_USAGE}\n`)
    return ExitCode.OK
  }
  const parsed = parseRunArgs(rest)
  parsed.args.cwd = resolve(deps.cwd, parsed.args.cwd ?? '.')
  const ac = new AbortController()
  let outputError: Error | undefined
  const onOutputError = (error: Error) => {
    outputError = error
    ac.abort()
  }
  deps.stdout.on('error', onOutputError)
  let signal: SignalName | undefined
  let booted: Booted | undefined
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const off = installSignalLadder(
    {
      cancel: async () => {
        ac.abort()
      },
      close: async () => {
        await finished
      },
    },
    {
      graceMs: 5000,
      exit: deps.exit ?? ((code) => process.exit(code)),
      ...(deps.signals ? { proc: deps.signals } : {}),
      onSignal: (received) => {
        signal = received
      },
    },
  )
  try {
    const inputPath = parsed.input === '-' ? '-' : resolve(deps.cwd, parsed.input)
    const inputs = parsed.batch
      ? (await readdir(inputPath, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => resolve(inputPath, entry.name))
          .sort()
      : [inputPath]
    if (!inputs.length) throw new UsageError('headless input folder has no regular files')
    // Validate and read the first input before starting a Host or loading any plugins.
    let first = await readInput(inputs[0]!, deps.stdin, ac.signal)
    ac.signal.throwIfAborted()
    booted = await deps.boot({ bundle: parsed.bundle, args: parsed.args, signal: ac.signal })
    await booted.client.workspace.add(parsed.args.cwd)
    let code: number = ExitCode.OK
    for (let index = 0; index < inputs.length; index++) {
      if (ac.signal.aborted) break
      const runId = randomUUID()
      try {
        const input = index === 0 ? first : await readInput(inputs[index]!, deps.stdin, ac.signal)
        first = ''
        const result = await runHeadless(booted.client, {
          cwd: parsed.args.cwd,
          input,
          runId,
          signal: ac.signal,
          ...(parsed.args.preset ? { preset: parsed.args.preset } : {}),
          ...(parsed.args.loop ? { loop: parsed.args.loop } : {}),
          ...(parsed.args.model ? { model: parsed.args.model } : {}),
          write: (record) => writeLine(deps.stdout, { ...record, input: inputs[index] }),
        })
        const itemCode =
          result.reason === 'failed' || !result.eventsComplete
            ? ExitCode.ERROR
            : exitCodeForReason(result.reason)
        if (itemCode !== ExitCode.OK && code === ExitCode.OK) code = itemCode
      } catch (error) {
        if (outputError) throw outputError
        await writeLine(deps.stdout, {
          schemaVersion: 1,
          type: 'error',
          runId,
          input: inputs[index],
          error: error instanceof Error ? error.message : String(error),
        })
        if (code === ExitCode.OK) code = ExitCode.ERROR
      }
    }
    return signal ? SIGNAL_EXIT_CODES[signal] : code
  } catch (error) {
    if (signal) return SIGNAL_EXIT_CODES[signal]
    throw error
  } finally {
    try {
      await booted?.close()
    } finally {
      finish()
      off()
      deps.stdout.off('error', onOutputError)
    }
  }
}
