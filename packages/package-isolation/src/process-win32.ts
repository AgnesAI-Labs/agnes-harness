import { startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import type { runIsolatedCommand } from './process.js'

export async function runWindowsIsolatedCommand(
  command: string,
  args: readonly string[],
  options: Parameters<typeof runIsolatedCommand>[2],
): Promise<{ stdout: string }> {
  const controller = new AbortController()
  let failure: Error | undefined
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
    const chunks: Buffer[] = []
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
    if (
      failure &&
      cause instanceof Error &&
      (cause.name === 'AbortError' || ('code' in cause && cause.code === 'ABORT_ERR'))
    )
      throw failure
    throw cause
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
