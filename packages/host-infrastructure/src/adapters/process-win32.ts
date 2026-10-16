import {
  type ProcessOutput,
  type SandboxProcess,
  type SandboxProcessRequest,
  SHELL_STDIN_SENTINEL,
  sandboxUnavailable,
} from '@agnes/extension-api'
import { mergeWindowsEnvironment, startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import { commandOutputDecoder } from './command-output.js'
import type { PowerShellDescriptor } from './powershell.js'
import { powerShellEncoding } from './powershell-command.js'
import { preparePowerShellFile } from './powershell-file.js'

/** Policy-authorized pipes. The invocation owns startup; the returned handle owns the Job. */
export async function openWindowsProcess(
  request: SandboxProcessRequest,
  options: {
    nodeExecutable: string
    baseEnv: Record<string, string>
    powerShell?: PowerShellDescriptor
  },
): Promise<SandboxProcess> {
  request.signal?.throwIfAborted()
  if (request.pty) throw sandboxUnavailable('local Windows PTY needs a ConPTY provider')
  const stdinShell = request.argv[0] === SHELL_STDIN_SENTINEL
  if (stdinShell && (request.argv.length !== 1 || !options.powerShell))
    throw sandboxUnavailable('configured PowerShell stdin shell is unavailable')
  const argv = stdinShell
    ? [
        options.powerShell!.path,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-OutputFormat',
        'Text',
        '-Command',
        '-',
      ]
    : [...request.argv]
  const prepared = preparePowerShellFile(options.powerShell, argv)
  const startup = new AbortController()
  const abort = () => startup.abort(request.signal?.reason)
  request.signal?.addEventListener('abort', abort, { once: true })
  if (request.signal?.aborted) abort()
  let child: Awaited<ReturnType<typeof startWindowsJobProcess>>
  try {
    child = await startWindowsJobProcess(prepared.argv, {
      cwd: request.cwd,
      env: mergeWindowsEnvironment(options.baseEnv, request.env),
      nodeExecutable: options.nodeExecutable,
      signal: startup.signal,
    })
  } catch (cause) {
    request.signal?.removeEventListener('abort', abort)
    try {
      prepared.dispose()
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Windows process startup and cleanup failed')
    }
    throw cause
  }
  const listeners = new Set<(chunk: ProcessOutput) => void>()
  const pending: ProcessOutput[] = []
  let bytes = 0,
    ended = false
  const emit = (chunk: ProcessOutput) => {
    if (!chunk.text) return
    if (listeners.size) {
      for (const listener of listeners) listener(chunk)
      return
    }
    pending.push(chunk)
    bytes += Buffer.byteLength(chunk.text)
    while (bytes > 65536 && pending.length > 1) bytes -= Buffer.byteLength(pending.shift()!.text)
  }
  const out = commandOutputDecoder(options.powerShell?.codePage),
    err = commandOutputDecoder(options.powerShell?.codePage)
  child.stdout.on('data', (data: Buffer) => emit({ stream: 'stdout', text: out.write(data) }))
  child.stderr.on('data', (data: Buffer) => emit({ stream: 'stderr', text: err.write(data) }))
  const exited = child.completion.then((result) => {
    ended = true
    emit({ stream: 'stdout', text: out.end() })
    emit({ stream: 'stderr', text: err.end() })
    let error = result.error
    try {
      prepared.dispose()
    } catch (cleanup) {
      error = new AggregateError([...(error ? [error] : []), cleanup], 'Windows process cleanup failed')
    }
    return {
      code: result.code,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(error ? { error } : {}),
      ...(result.stoppedProcesses === undefined ? {} : { stoppedProcesses: result.stoppedProcesses }),
    }
  })
  const cleanup = exited.then((result) => {
    if (result.error) throw result.error
  })
  // A natural exit may precede a caller awaiting close. Keep the rejection observable without an unhandled promise.
  void cleanup.catch(() => undefined)
  const close = () => {
    child.terminate()
    return cleanup
  }
  const handle: SandboxProcess = {
    enforcement: request.enforcement ?? { level: 'none', scope: [] },
    exited,
    onOutput(listener) {
      listeners.add(listener)
      for (const chunk of pending.splice(0)) listener(chunk)
      bytes = 0
      return () => listeners.delete(listener)
    },
    write(text) {
      if (ended) return Promise.reject(new Error('process has exited'))
      return new Promise<void>((resolve, reject) =>
        child.stdin.write(text, (error) => (error ? reject(error) : resolve())),
      )
    },
    resize: async () => {
      throw new Error('process is not a PTY')
    },
    signal: close,
    close,
  }
  try {
    if (stdinShell) await handle.write(`${powerShellEncoding.replaceAll('\n', '; ')}\n`)
    request.signal?.throwIfAborted()
    // Core aborts its call signal even on successful background handoff. Do not carry it into Job lifetime.
    request.signal?.removeEventListener('abort', abort)
    return handle
  } catch (cause) {
    request.signal?.removeEventListener('abort', abort)
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([cause, cleanupError], 'Windows process handoff and cleanup failed')
    }
    throw cause
  }
}
