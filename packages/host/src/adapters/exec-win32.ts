import { mergeWindowsEnvironment, startWindowsJobProcess } from '@agnes/system-node/process-spawn'
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
      if (!argv[0]) return Promise.reject(new Error('exec: empty argv'))
      if (opts.signal?.aborted)
        return Promise.reject(
          opts.signal.reason instanceof Error ? opts.signal.reason : new Error('exec: aborted before start'),
        )
      const controller = new AbortController()
      let timedOut = false
      const output = createExecOutput(opts.maxOutputBytes ?? 1024 * 1024)
      const cancel = () => controller.abort()
      const timer = setTimeout(() => {
        timedOut = true
        cancel()
      }, opts.timeoutMs ?? options.defaultTimeoutMs)
      opts.signal?.addEventListener('abort', cancel, { once: true })
      if (opts.signal?.aborted) cancel()
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
          opts.signal?.removeEventListener('abort', cancel)
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
