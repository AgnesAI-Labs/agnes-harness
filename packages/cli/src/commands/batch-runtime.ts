import { bootDefault, type DefaultBootDeps } from '../boot/default.js'
import { SIGNAL_EXIT_CODES } from '../errors.js'
import type { Booted, ParsedArgs } from '../types.js'
import { batchCommand } from './batch.js'
import { scopedBatchClient } from './batch-client.js'

/** The CLI owns its connection only; closing it does not cancel durable backend work. */
export async function runBatchCli(
  rest: readonly string[],
  io: { cwd: string; stdout: NodeJS.WritableStream; signals?: NodeJS.EventEmitter },
  boot: (input: { cwd: string; profile?: string; signal: AbortSignal }) => Promise<Booted>,
): Promise<number> {
  const controller = new AbortController()
  const signals = io.signals ?? process
  let exitCode: number = 1
  let closeCurrent: (() => Promise<void>) | undefined
  const handlers = (Object.keys(SIGNAL_EXIT_CODES) as (keyof typeof SIGNAL_EXIT_CODES)[]).map((name) => {
    const handler = () => {
      exitCode = SIGNAL_EXIT_CODES[name]
      controller.abort()
      void closeCurrent?.().catch(() => undefined)
    }
    signals.on(name, handler)
    return [name, handler] as const
  })
  try {
    return await batchCommand(rest, {
      cwd: io.cwd,
      write: (text) => {
        io.stdout.write(text)
      },
      signal: controller.signal,
      async connect(input) {
        const connected = await boot({ ...input, signal: controller.signal })
        let closing: Promise<void> | undefined
        const close = () => {
          closing ??= connected.close()
          return closing
        }
        closeCurrent = close
        if (controller.signal.aborted) {
          await close()
          controller.signal.throwIfAborted()
        }
        return scopedBatchClient(connected.client, close)
      },
    })
  } catch (error) {
    if (controller.signal.aborted) return exitCode
    throw error
  } finally {
    for (const [name, handler] of handlers) signals.off(name, handler)
  }
}

/** Entry dispatch has no session creation or batch business logic. */
export function dispatchBatchCli(
  parsed: ParsedArgs,
  io: { cwd: string; stdout: NodeJS.WritableStream; signals?: NodeJS.EventEmitter },
  deps: DefaultBootDeps,
  useEmbedded: boolean,
): Promise<number> {
  return runBatchCli(parsed.rest, io, (input) =>
    bootDefault(
      { ...parsed, cwd: input.cwd, ...(input.profile ? { profile: input.profile } : {}) },
      { ...deps, signal: input.signal },
      { useEmbedded },
    ),
  )
}
