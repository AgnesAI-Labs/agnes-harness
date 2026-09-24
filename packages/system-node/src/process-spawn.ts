import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, parse } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  createWindowsProcessJob,
  windowsEnvironmentNamesEqual,
  windowsProcessStartTimeSync,
} from './index.js'

const windows = process.platform === 'win32' // guards-allow-platform: shared Windows lifecycle leaf.

type ExitStatus = { code: number | null; signal: string | null }
export type WindowsJobProcess = {
  pid: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
  completion: Promise<ExitStatus & { cancelled: boolean; error?: Error }>
  terminate(): void
}
type Options = {
  cwd: string
  env: Record<string, string>
  /** Trusted Node executable, supplied explicitly; never substitute the CLI's SEA executable. */
  nodeExecutable: string
  signal?: AbortSignal
  startupTimeoutMs?: number
  /** Extra parsing only for a known batch wrapper forwarding %* to a native program. */
  windowsBatch?: 'script' | 'argv-proxy'
}
const error = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** Windows names are case-insensitive; later layers (including empty values) override earlier ones. */
export function mergeWindowsEnvironment(
  ...layers: Array<Readonly<Record<string, string>> | undefined>
): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (const layer of layers)
    for (const entry of Object.entries(layer ?? {})) {
      const existing = entries.findIndex(([name]) => windowsEnvironmentNamesEqual(name, entry[0]))
      if (existing < 0) entries.push(entry)
      else entries[existing] = entry
    }
  return Object.fromEntries(entries)
}

/** Owned finite command only. Shared daemons require a separate lifetime and must not use this gate. */
export function startWindowsJobProcess(argv: string[], options: Options): Promise<WindowsJobProcess> {
  if (!windows) return Promise.reject(error('ENOSYS', 'Windows process gate unavailable'))
  const timeout = options.startupTimeoutMs ?? 10_000
  if (
    !argv.length ||
    !argv[0] ||
    argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    !isAbsolute(options.cwd) ||
    parse(options.cwd).root.length < 2 ||
    options.cwd.includes('\0') ||
    !isAbsolute(options.nodeExecutable) ||
    parse(options.nodeExecutable).root.length < 2 ||
    options.nodeExecutable.includes('\0') ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 2_147_483_647 ||
    (options.windowsBatch !== undefined && !['script', 'argv-proxy'].includes(options.windowsBatch)) ||
    Object.entries(options.env).some(
      ([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'),
    )
  )
    return Promise.reject(error('EINVAL', 'Invalid Windows process gate options'))
  if (options.signal?.aborted)
    return Promise.reject(options.signal.reason ?? error('ABORT_ERR', 'Process start cancelled'))
  argv = [...argv]
  options = { ...options, env: mergeWindowsEnvironment(options.env) }
  return new Promise((resolve, reject) => {
    const job = createWindowsProcessJob()
    let brokerPath: string
    try {
      brokerPath = createRequire(import.meta.url).resolve('@agnes/system-node/process-broker')
    } catch (cause) {
      job.close()
      reject(cause)
      return
    }
    // NODE_OPTIONS/NODE_PATH and the business environment must not execute code before assignment.
    const bootstrapEnv = Object.fromEntries(
      ['SystemRoot', 'TEMP', 'TMP'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key] as string]],
      ),
    )
    let broker: ChildProcessWithoutNullStreams
    try {
      broker = spawn(options.nodeExecutable, [brokerPath], {
        cwd: dirname(brokerPath),
        env: bootstrapEnv,
        windowsHide: true,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      }) as ChildProcessWithoutNullStreams // The first three stdio entries are explicitly pipes.
    } catch (cause) {
      job.close()
      reject(cause)
      return
    }
    let started = false
    let released = false
    let stopped = false
    let cancelled = false
    let failure: Error | undefined
    let targetExit: ExitStatus | undefined
    let complete: (status: ExitStatus & { cancelled: boolean; error?: Error }) => void = () => {}
    const completion: WindowsJobProcess['completion'] = new Promise((done) => {
      complete = done
    })
    const stop = () => {
      if (stopped) return
      stopped = true
      try {
        job.terminate()
      } catch (cause) {
        failure ??= cause as Error
      }
      // Also covers cancellation before the trusted broker was assigned to the Job.
      broker.kill('SIGKILL')
    }
    const abort = () => {
      cancelled = true
      stop()
    }
    const fail = (cause: Error) => {
      failure ??= cause
      stop()
    }
    const observation = setInterval(() => {
      try {
        job.terminationComplete()
      } catch (cause) {
        fail(cause as Error)
      }
    }, 20)
    const timer = setTimeout(
      () => fail(error('ETIMEDOUT', 'Windows process gate startup timed out')),
      timeout,
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    // Close the registration race, without permitting the gate to release after cancellation.
    if (options.signal?.aborted) abort()
    broker.once('error', fail)
    broker.once('spawn', () => {
      if (stopped) broker.kill('SIGKILL')
    })
    broker.stdin.on('error', () => {}) // The target may intentionally exit without reading stdin.
    broker.stdout.on('error', fail)
    broker.stderr.on('error', fail)
    broker.on('message', (raw) => {
      if (stopped) return
      const message = raw as Record<string, unknown> | null
      if (!message || typeof message !== 'object') {
        fail(error('EPROTO', 'Invalid process gate reply'))
        return
      }
      if (message.type === 'ready' && message.version === 1 && !released) {
        try {
          const pid = broker.pid
          const identity = pid === undefined ? null : windowsProcessStartTimeSync(pid)
          if (pid === undefined || identity === null)
            throw error('E_PROCESS_EXITED', 'Process gate exited before assignment')
          job.assign(pid, identity)
          released = true
          broker.send(
            {
              type: 'run',
              argv,
              cwd: options.cwd,
              env: options.env,
              windowsBatch: options.windowsBatch ?? 'script',
            },
            (cause) => {
              if (cause) fail(cause)
            },
          )
        } catch (cause) {
          fail(cause as Error)
        }
      } else if (
        message.type === 'started' &&
        released &&
        !started &&
        Number.isSafeInteger(message.pid) &&
        Number(message.pid) > 0
      ) {
        started = true
        clearTimeout(timer)
        resolve({
          pid: Number(message.pid),
          stdin: broker.stdin,
          stdout: broker.stdout,
          stderr: broker.stderr,
          completion,
          terminate: abort,
        })
      } else if (
        message.type === 'exit' &&
        started &&
        !targetExit &&
        (message.code === null || Number.isInteger(message.code)) &&
        (message.signal === null || typeof message.signal === 'string')
      ) {
        targetExit = { code: message.code as number | null, signal: message.signal as string | null }
      } else if (
        message.type === 'error' &&
        typeof message.code === 'string' &&
        /^[A-Z0-9_]+$/.test(message.code)
      ) {
        fail(error(message.code, 'Windows target process could not start'))
      } else fail(error('EPROTO', 'Unexpected process gate reply'))
    })
    broker.once('exit', stop)
    broker.once('close', (code, signal) => {
      clearTimeout(timer)
      clearInterval(observation)
      options.signal?.removeEventListener('abort', abort)
      void (async () => {
        try {
          const deadline = Date.now() + 5000
          while (!job.terminationComplete()) {
            if (Date.now() >= deadline)
              throw error('E_JOB_CLEANUP_TIMEOUT', 'Windows job did not finish terminating')
            await new Promise((done) => setTimeout(done, 10))
          }
        } catch (cause) {
          failure ??= cause as Error
        } finally {
          try {
            job.close()
          } catch (cause) {
            failure ??= cause as Error
          }
        }
        if (!targetExit && !cancelled)
          failure ??= error('E_PROCESS_GATE_EXIT', 'Process gate exited without a target result')
        if (!started) reject(failure ?? error('ABORT_ERR', 'Windows process start cancelled'))
        complete({ ...(targetExit ?? { code, signal }), cancelled, ...(failure ? { error: failure } : {}) })
      })()
    })
  })
}
