import { isSea } from 'node:sea'
import { startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import type { HealthProbe } from './health.js'
import type { SurfaceEndpoint, SurfaceRuntimeHandle } from './types.js'

/** Surface lifetime includes descendants; never identify or kill them by recycled PIDs. */
export async function startWindowsSurface(o: {
  executable: string
  entry: string
  cwd: string
  env: Record<string, string>
  signal: AbortSignal
  endpoint: SurfaceEndpoint
  sourceId: string
  probe: HealthProbe
  cleanup?: (sourceId: string) => void | Promise<void>
}): Promise<SurfaceRuntimeHandle> {
  if (isSea() && o.executable === process.execPath)
    throw new Error('Windows Surface requires a Node.js runtime, not the SEA executable')
  const startup = new AbortController()
  const abort = () => startup.abort(o.signal.reason)
  o.signal.addEventListener('abort', abort, { once: true })
  if (o.signal.aborted) abort()
  const job = await startWindowsJobProcess([o.executable, o.entry], {
    cwd: o.cwd,
    env: o.env,
    nodeExecutable: o.executable,
    signal: startup.signal,
  }).finally(() => o.signal.removeEventListener('abort', abort))
  if (o.signal.aborted) {
    job.terminate()
    await job.completion
    throw o.signal.reason
  }
  job.stdin.end()
  job.stdout.resume()
  job.stderr.resume()
  let cleanup: Promise<void> | undefined
  return {
    sourceId: o.sourceId,
    endpoint: o.endpoint,
    pid: job.pid,
    exited: job.completion.then((result) => ({
      code: result.error ? 1 : result.code,
      signal: result.cancelled ? 'SIGKILL' : null,
    })),
    probe: (signal) => o.probe(o.endpoint, signal),
    terminate: () => job.terminate(),
    kill: () => job.terminate(),
    cleanup() {
      cleanup ??= (async () => {
        job.terminate()
        const result = await job.completion
        if (result.error) throw result.error
        await o.cleanup?.(o.sourceId)
      })().catch((error: unknown) => {
        cleanup = undefined
        throw error
      })
      return cleanup
    },
  }
}
