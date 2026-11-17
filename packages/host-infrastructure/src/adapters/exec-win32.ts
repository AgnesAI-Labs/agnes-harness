import { mergeWindowsEnvironment, startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import { type WindowsLaunch, windowsLaunch } from '../windows-acl/launch.js'
import type { ExecAdapter, ExecResult } from './exec.js'
import { createExecOutput } from './exec-output.js'
import type { PowerShellDescriptor } from './powershell.js'
import { preparePowerShellFile } from './powershell-file.js'

/** Finite Host commands only; the Job owns every process spawned by one command. */
export function createWindowsExec(options: {
  nodeExecutable: string
  baseEnv: Record<string, string>
  defaultTimeoutMs: number
  powerShell?: PowerShellDescriptor
}): ExecAdapter {
  const live = new Set<{ cancel(): void; done: Promise<ExecResult> }>()
  return {
    run(argv, opts) {
      // A Host-issued permit is redeemed first, so every refusal below also settles it.
      let launch: WindowsLaunch | undefined
      try {
        launch = opts.windowsAcl ? windowsLaunch(opts.windowsAcl) : undefined
      } catch (error) {
        return Promise.reject(error)
      }
      const refuse = (error: Error) => {
        launch?.abandoned()
        return Promise.reject(error)
      }
      if (opts.bridge)
        return refuse(new Error('SANDBOX_UNAVAILABLE: Windows programmatic transport is unavailable'))
      if (!argv[0]) return refuse(new Error('exec: empty argv'))
      if (opts.signal?.aborted)
        return refuse(
          opts.signal.reason instanceof Error ? opts.signal.reason : new Error('exec: aborted before start'),
        )
      const controller = new AbortController()
      let timedOut = false
      let cancelledFirst = false
      const output = createExecOutput(opts.maxOutputBytes ?? 1024 * 1024, options.powerShell?.codePage)
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
            // The request cannot move TEMP/TMP out of the lease's private temp.
            env: mergeWindowsEnvironment(options.baseEnv, opts.env, launch?.env),
            nodeExecutable: options.nodeExecutable,
            signal: controller.signal,
            ...(launch ? { confinement: launch.confinement } : {}),
          })
          launch?.started(child.completion)
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
            ...(result.stoppedProcesses === undefined ? {} : { stoppedProcesses: result.stoppedProcesses }),
            ...(signal === undefined ? {} : { signal }),
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
          // Never a fallback: a restricted launch that did not start leaves no process behind.
          launch?.abandoned()
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
          prepared?.dispose()
        }
      }
      const task = { cancel, done: execute() }
      live.add(task)
      return task.done.finally(() => live.delete(task))
    },
    async killAll() {
      const tasks = [...live]
      for (const task of tasks) task.cancel()
      const results = await Promise.allSettled(tasks.map((task) => task.done))
      const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      if (errors.length) throw new AggregateError(errors, 'Windows command cleanup failed')
    },
  }
}
