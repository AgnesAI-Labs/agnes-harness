import { appendFileSync } from 'node:fs'
import { runRuntimeTargetProbeExecutable, runWorkerExecutable } from '@agnes/daemon/worker'
import { admissionOwnerFixture } from '../../../worker-runtime/test/fixtures/runtime-admission-owner.js'

// J-19 installer / J-22 publication-codec source: routing-only identity/State owner.
// No native admission authorization or production release/storage anchor is manufactured.
// Keep the actual worker executable, filesystem package loader and Host assembly intact.
const log = process.env.FIRST_PATH_LOG
if (process.env.AGNES_WORKER_KIND === 'probe') {
  await runRuntimeTargetProbeExecutable()
} else {
  if (!log) throw Error('Missing isolated fixture log')
  const owner = admissionOwnerFixture({
    observe: (event) => appendFileSync(log, `${JSON.stringify({ pid: process.pid, ...event })}\n`),
  })
  await runWorkerExecutable({ runtimeAdmissionInstallation: owner.installation })
}
