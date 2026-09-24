#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { runRuntimeTargetProbeExecutable, runWorkerExecutable } from '@agnes/daemon/worker'
import { agnesHome } from '@agnes/host'
import { createPackagedHost } from './packaged-host.js'
import { workerFailureCode } from './worker-failure.js'

const worker =
  process.env.AGNES_WORKER_KIND === 'probe'
    ? runRuntimeTargetProbeExecutable()
    : runWorkerExecutable({
        buildHost: (profile, prompter, resources) =>
          createPackagedHost(profile, prompter, {
            home: agnesHome(process.env),
            cwd: process.env.AGNES_WORKER_ROOT ?? process.cwd(),
            entryFile: fileURLToPath(import.meta.url),
            ...resources,
          }),
      })

void worker.catch((error: unknown) => {
  // The supervisor receives the nonzero exit; package/provider secrets do not become process logs.
  process.stderr.write(`packaged worker failed to assemble or connect (${workerFailureCode(error)})\n`)
  process.exit(1)
})
