import { pathToFileURL } from 'node:url'
import type { WorkerHostDeps } from '@agnes/worker-runtime'
import {
  reportWorkerBootFailure,
  runRuntimeTargetProbeExecutable,
  runWorkerExecutable as runRuntimeWorkerExecutable,
} from '@agnes/worker-runtime'
import { daemonChannelRuntime } from '../channels/runtime.js'

export * from '@agnes/worker-runtime'

export function runWorkerExecutable(deps: WorkerHostDeps = {}): Promise<void> {
  return runRuntimeWorkerExecutable({ channelRuntime: daemonChannelRuntime, ...deps })
}

declare const AGNES_COMPOSED_WORKER: boolean | undefined

if (
  (typeof AGNES_COMPOSED_WORKER === 'undefined' || !AGNES_COMPOSED_WORKER) &&
  (process.env.AGNES_WORKER_TOKEN || process.env.AGNES_WORKER_KIND === 'probe') &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void (
    process.env.AGNES_WORKER_KIND === 'probe' ? runRuntimeTargetProbeExecutable() : runWorkerExecutable()
  ).catch(async (error: unknown) => {
    await reportWorkerBootFailure(error)
    console.error('agnes worker failed to start:', error)
    process.exit(1)
  })
}
