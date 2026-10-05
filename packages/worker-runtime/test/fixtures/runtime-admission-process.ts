import { appendFileSync } from 'node:fs'
import { createTestHost } from '@agnes/host/testkit'
import { runWorkerExecutable } from '../../src/main.js'
import { admissionOwnerFixture } from './runtime-admission-owner.js'
import { loopOwnerFixture } from './runtime-loop-owner.js'

const log = process.env.ADMISSION_FIXTURE_LOG
const owner = log
  ? admissionOwnerFixture({
      observe: (event) => appendFileSync(log, `${JSON.stringify(event)}\n`),
    })
  : undefined
const loop = process.env.LOOP_FIXTURE_MODE
  ? await loopOwnerFixture(process.env.LOOP_FIXTURE_MODE, (event) => {
      if (log) appendFileSync(log, `${JSON.stringify(event)}\n`)
    })
  : undefined
const installation = owner
  ? { ...owner.installation, ...(loop ? { loop: loop.installation } : {}) }
  : undefined

await runWorkerExecutable({
  ...(installation ? { runtimeAdmissionInstallation: installation } : {}),
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
