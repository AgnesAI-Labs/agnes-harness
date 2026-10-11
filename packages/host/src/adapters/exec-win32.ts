import type { SandboxProcess } from '@agnes/core'
import { mergeWindowsEnvironment, startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import type { ExecAdapter, ExecResult } from './exec.js'
import { createExecOutput } from './exec-output.js'
import { ownedProcess } from './exec-owned.js'
import type { PowerShellDescriptor } from './powershell.js'
import { preparePowerShellFile } from './powershell-file.js'

/** The Job owns every process one command spawns: a finite command's, or a background job's until it is stopped. */
export function createWindowsExec(options: {
  nodeExecutable: string
  baseEnv: Record<string, string>
  defaultTimeoutMs: number
  powerShell?: PowerShellDescriptor
}): ExecAdapter {
  const live = new Set<{ cancel(): void; done: Promise<ExecResult> }>()
  const started = new Set<SandboxProcess>()
  // Every command gets a new console, which starts in the code page the probe found.
  const codePage = options.powerShell?.codePage
  return {
    run(argv, opts) {
      if (!argv[0]) return Promise.reject(new Error('exec: empty argv'))
      if (opts.signal?.aborted)
        return Promise.reject(
          opts.signal.reason instanceof Error ? opts.signal.reason : new Error('exec: aborted before start'),
        )
      const controller = new AbortController()
      let timedOut = false
      let cancelledFirst = false
      const output = createExecOutput(opts.maxOutputBytes ?? 1024 * 1024, codePage)
      const cancel = () => controller.abort()
      const timer = setTimeout(() => {
        // First cause wins: a cancel that came first is not reported as a timeout.
        if (cancelledFirst) return
        timedOut = true
        cancel()
      }, opts.timeoutMs ?? options.defaultTimeoutMs)
      const onAbort = () => {
        cancelledFirst = true
        cancel()
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.signal?.aborted) onAbort()
      const execute = async (): Promise<ExecResult> => {
        let prepared: ReturnType<typeof preparePowerShellFile> | undefined
        try {
          prepared = preparePowerShellFile(options.powerShell, argv)
          const child = await startWindowsJobProcess(prepared.argv, {
            cwd: opts.cwd,
            env: mergeWindowsEnvironment(options.baseEnv, opts.env),
            nodeExecutable: options.nodeExecutable,
            signal: controller.signal,
          })
          child.stdout.on('data', output.stdout)
          child.stderr.on('data', output.stderr)
          child.stdin.end(opts.stdin)
          const result = await child.completion
          if (result.error) throw result.error
          const signal = result.signal ?? (result.cancelled ? 'SIGKILL' : undefined)
          return {
            code: result.code ?? -1,
            ...output.result(),
            timedOut,
            ...(signal === undefined ? {} : { signal }),
            ...(result.stoppedProcesses ? { stoppedProcesses: result.stoppedProcesses } : {}),
          }
        } catch (cause) {
          // Only expected startup cancellation maps to an ExecResult; cleanup failures remain errors.
          if (
            controller.signal.aborted &&
            cause instanceof Error &&
            (cause.name === 'AbortError' || ('code' in cause && cause.code === 'ABORT_ERR'))
          )
            return { code: -1, ...output.result(), timedOut, signal: 'SIGKILL' }
          throw cause
        } finally {
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
          prepared?.dispose()
        }
      }
      const task = { cancel, done: execute() }
      live.add(task)
      return task.done.finally(() => live.delete(task))
    },
    async start(argv, opts) {
      if (!argv[0]) throw new Error('exec: empty argv')
      const prepared = preparePowerShellFile(options.powerShell, argv)
      let child: Awaited<ReturnType<typeof startWindowsJobProcess>>
      try {
        child = await startWindowsJobProcess(prepared.argv, {
          cwd: opts.cwd,
          env: mergeWindowsEnvironment(options.baseEnv, opts.env),
          nodeExecutable: options.nodeExecutable,
        })
      } catch (cause) {
        prepared.dispose()
        throw cause
      }
      child.stdin.end()
      // When the job's own process ends, the gate stops the rest of the Job with it, as for any
      // command; `stop` ends it earlier.
      const done = child.completion.then((result) => {
        prepared.dispose()
        return { code: result.code, ...(result.signal ? { signal: result.signal } : {}) }
      })
      const owned = ownedProcess({
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        ...(codePage === undefined ? {} : { codePage }),
        done,
        stop: async () => {
          child.terminate()
          await done
          started.delete(owned)
        },
      })
      started.add(owned)
      return owned
    },
    async killAll() {
      await Promise.allSettled([...started].map((process) => process.stop()))
      const tasks = [...live]
      for (const task of tasks) task.cancel()
      const results = await Promise.allSettled(tasks.map((task) => task.done))
      const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, 'Windows command cleanup failed')
    },
  }
}
