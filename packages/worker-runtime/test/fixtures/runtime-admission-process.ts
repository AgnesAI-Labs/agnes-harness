import { appendFileSync } from 'node:fs'
import { createTestHost } from '@agnes/host/testkit'
import { runWorkerExecutable } from '../../src/main.js'
import { admissionOwnerFixture } from './runtime-admission-owner.js'

const log = process.env.ADMISSION_FIXTURE_LOG
const owner = log
  ? admissionOwnerFixture({
      observe: (event) => appendFileSync(log, `${JSON.stringify(event)}\n`),
    })
  : undefined

await runWorkerExecutable({
  ...(owner ? { runtimeAdmissionInstallation: owner.installation } : {}),
  async buildHost(profile, prompter, resources) {
    const { host } = await createTestHost({
      dataDir: profile.dataDir,
      ...(resources.runtimeAdmissionInstallation
        ? { runtimeAdmissionInstallation: resources.runtimeAdmissionInstallation }
        : {}),
      disableSessionTitle: true,
      prompter: (request, options) => prompter.ask(request, options),
      script: [
        [
          { type: 'text_delta', delta: 'legacy worker reply' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    return host
  },
})
