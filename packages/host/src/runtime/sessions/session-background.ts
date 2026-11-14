import type { Kernel } from '@agnes/core'
import type { HostOptions, HostSession } from '../lifecycle/host.js'
import { startSessionTitle } from './session-title.js'
import { sessionWorkFor } from './session-work.js'
import { titleEligibilityAuthority } from './title-eligibility.js'

/** Optional writers close and settle before the session releases its ledger writer lease. */
export async function startSessionBackground(
  kernel: Kernel,
  session: HostSession,
  options: HostOptions,
  skip: boolean | undefined,
  schedule: (work: () => Promise<void>) => Promise<void>,
) {
  if (skip) return { close: async () => {} }
  const work = await sessionWorkFor(kernel).start(
    session,
    titleEligibilityAuthority(options.autoTitleEligible).check,
  )
  let title: Awaited<ReturnType<typeof startSessionTitle>> | undefined
  if (!options.disableSessionTitle) {
    try {
      title = await startSessionTitle(session, {
        schedule,
        onError: () => options.log.warn('session title background task failed', { sessionKey: session.key }),
      })
    } catch {
      options.log.warn('session title initialization failed', { sessionKey: session.key })
    }
  }
  return {
    async close() {
      await work.close()
      await title?.close()
    },
  }
}
