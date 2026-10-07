import { defineExtension } from '@agnes/extension-api'
import { type ShellJobs, standaloneShellJobs } from '../src/registry.js'
import { createJobsServices } from '../src/services.js'

/** A separate admission surface: an older profile without services keeps its shell/job tools. */
export function createJobsWebExtension(jobs: ShellJobs) {
  return defineExtension((agnes) => {
    const disposers = createJobsServices(jobs).map((service) => agnes.registerService(service))
    disposers.push(
      agnes.registerHook('shutdown', async (_payload, ctx) => {
        await jobs.closeSession(ctx.session.key, ctx.session.lane)
      }),
    )
    return async () => {
      for (const dispose of disposers) dispose()
      await jobs.closeTerminals()
    }
  })
}
export default createJobsWebExtension(standaloneShellJobs)
