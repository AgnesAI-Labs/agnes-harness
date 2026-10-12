import { type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'
import { type ShellJobs, standaloneShellJobs } from '../../jobs/src/registry.js'
import { createJobsServices } from '../../jobs/src/services.js'

/** A separate admission surface: an older profile without services keeps its shell/job tools. */
export function createJobsWebExtension(jobs: ShellJobs) {
  return defineAgnesPlugin({
    inject: ['hooks', 'services'],
    apply(plugin: Context) {
      const disposers = createJobsServices(jobs).map((service) => plugin.services.register(service))
      disposers.push(
        plugin.hooks.register('shutdown', async (_payload, ctx) => {
          await jobs.closeSession(ctx.session.key, ctx.session.lane)
        }),
      )
      return async () => {
        for (const dispose of disposers) dispose()
        await jobs.closeTerminals()
      }
    },
  })
}
export default createJobsWebExtension(standaloneShellJobs)
