import { type ChildProcess, spawn } from 'node:child_process'
import { runWindowsIsolatedCommand } from './process-win32.js'

const windows = process.platform === 'win32' // guards-allow-platform: shared bounded command platform dispatch.

/**
 * A failed spawn (e.g. ENOENT) leaves `child.pid` undefined for the life of this object. The old
 * `child.pid ?? 0` fallback turned that into `process.kill(-0, signal)` -- POSIX treats pid 0 as
 * "this process's own group", so a spawn failure racing an abort signaled the caller's entire
 * process group instead of the (nonexistent) child.
 *
 * `child.kill()` is *not* a safe fallback here, despite looking like one: Node's own
 * `ChildProcess.prototype.kill` calls into the underlying libuv process handle regardless of
 * whether `pid` was ever assigned, and on a handle that never captured a real pid that call can
 * itself deliver the signal to this process's own group -- verified directly against this repo's
 * Node build (a real ENOENT spawn + `child.kill('SIGTERM')`, no `process.kill` involved at all,
 * terminates the caller). There is nothing to signal when spawn never produced a pid; Node emits
 * `close` on its own for a failed spawn regardless, so the caller's promise still settles.
 */
function signalIsolatedProcessTree(child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

/** Run a bounded command in a dedicated process group so cancellation reaps every descendant. */
export function runIsolatedCommand(
  command: string,
  args: readonly string[],
  options: Readonly<{
    cwd: string
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
    timeoutMs: number
    maxOutputBytes: number
    windowsBatch?: 'script' | 'argv-proxy'
  }>,
): Promise<{ stdout: string }> {
  if (options.signal?.aborted) return Promise.reject(new Error('command aborted'))
  if (windows) return runWindowsIsolatedCommand(command, args, options)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let failure: Error | undefined
    let terminating: Promise<void> | undefined
    const terminate = () => {
      if (terminating) return
      signalIsolatedProcessTree(child, 'SIGTERM')
      terminating = new Promise((done) => {
        setTimeout(() => {
          signalIsolatedProcessTree(child, 'SIGKILL')
          done()
        }, 1000)
      })
    }
    const abort = () => {
      failure ??= new Error('command aborted')
      terminate()
    }
    const timeout = setTimeout(() => {
      failure ??= new Error('command timed out')
      terminate()
    }, options.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > options.maxOutputBytes) {
        failure ??= new Error('command output exceeded limit')
        terminate()
        return
      }
      chunks.push(chunk)
    })
    child.once('error', (error) => {
      failure ??= error
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      void (terminating ?? Promise.resolve()).then(() => {
        if (failure) reject(failure)
        else if (code === 0) resolve({ stdout: Buffer.concat(chunks).toString('utf8') })
        else reject(new Error(`command exited with status ${code ?? 'signal'}`))
      })
    })
  })
}
