import { ExitCode, SIGNAL_EXIT_CODES, type SignalName, UsageError } from '../errors.js'
import type { Booted, ParsedArgs } from '../types.js'
import { pump } from './jsonl.js'

type AcpIO = {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  registerCancel?: (cancel: () => Promise<void>) => void
  /** Optional so a direct caller can drive pump() without a ladder; bin.ts always supplies it. */
  signal?: () => SignalName | undefined
}

export async function runAcp(booted: Booted, _args: ParsedArgs, io: AcpIO): Promise<number> {
  if (!booted.endpoint) throw new UsageError('local ACP endpoint is unavailable')
  const abort = new AbortController()
  io.registerCancel?.(async () => abort.abort())
  await pump({
    endpoint: booted.endpoint,
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    signal: abort.signal,
  })
  // A signalled run leaves with the signal's code, the same number the ladder exits with by its
  // own route (bin.ts:652-654, errors.ts:45-48). Aborting the pump is a clean shutdown, so
  // nothing else here reports it.
  const signal = io.signal?.()
  return signal ? SIGNAL_EXIT_CODES[signal] : ExitCode.OK
}
