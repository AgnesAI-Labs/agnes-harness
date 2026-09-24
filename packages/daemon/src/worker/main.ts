import { pathToFileURL } from 'node:url'
import { runRuntimeTargetProbeExecutable, runWorkerExecutable } from '@agnes/worker-runtime'

export * from '@agnes/worker-runtime'

declare const AGNES_COMPOSED_WORKER: boolean | undefined

if (
  (typeof AGNES_COMPOSED_WORKER === 'undefined' || !AGNES_COMPOSED_WORKER) &&
  (process.env.AGNES_WORKER_TOKEN || process.env.AGNES_WORKER_KIND === 'probe') &&
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void (
    process.env.AGNES_WORKER_KIND === 'probe' ? runRuntimeTargetProbeExecutable() : runWorkerExecutable()
  ).catch((error: unknown) => {
    console.error('agnes worker failed to start:', error)
    process.exit(1)
  })
}
