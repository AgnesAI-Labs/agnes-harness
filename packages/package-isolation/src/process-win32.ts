import { startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import type { runIsolatedCommand } from './process.js'
import { withCommandOutput } from './process-output.js'

export async function runWindowsIsolatedCommand(
  command: string,
  args: readonly string[],
  options: Parameters<typeof runIsolatedCommand>[2],
): Promise<{ stdout: string }> {
  const controller = new AbortController()
  let failure: Error | undefined
  let started = false
  const chunks: Buffer[] = []
  const stop = (message: string) => {
    failure ??= new Error(message)
    controller.abort()
  }
  const abort = () => stop('command aborted')
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = setTimeout(() => stop('command timed out'), options.timeoutMs)
  try {
    const child = await startWindowsJobProcess([command, ...args], {
      cwd: options.cwd,
      env: Object.fromEntries(
        Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      nodeExecutable: process.execPath,
      windowsBatch: options.windowsBatch ?? 'script',
      signal: controller.signal,
    })
    started = true
    let bytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > options.maxOutputBytes) stop('command output exceeded limit')
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.stdin.end()
    const result = await child.completion
    if (result.error) throw result.error
    if (failure) throw failure
    if (result.code !== 0) throw new Error(`command exited with status ${result.code ?? 'signal'}`)
    return { stdout: Buffer.concat(chunks).toString('utf8') }
  } catch (cause) {
    // Startup cancellation owns preflight failures; a started child's cleanup failure stays visible.
    if (
      failure &&
      !(cause instanceof Error && 'code' in cause && cause.code === 'E_JOB_CLEANUP_TIMEOUT') &&
      (!started ||
        (cause instanceof Error &&
          (cause.name === 'AbortError' || ('code' in cause && cause.code === 'ABORT_ERR'))))
    ) {
      if (cause !== failure) failure.cause = cause
      throw withCommandOutput(failure, chunks)
    }
    throw cause instanceof Error ? withCommandOutput(cause, chunks) : cause
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
