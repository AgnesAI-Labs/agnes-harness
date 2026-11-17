import type { HostOptions } from '@agnes/host'
import type { SharedSessionChannel } from './shared-session-channel.js'

/** Ask the bound presentation owner without borrowing a foreground invocation's context. */
export function autoTitlePolicy(
  channel: SharedSessionChannel,
  hasSession: (sessionKey: string) => boolean,
): Pick<HostOptions, 'autoTitleEligible'> {
  const autoTitleEligible: NonNullable<HostOptions['autoTitleEligible']> = async (sessionKey, signal) => {
    if (!hasSession(sessionKey)) return false
    try {
      return await channel.run(
        sessionKey,
        async () =>
          (await channel.request(
            'auto-title-eligible',
            {},
            AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
          )) === true,
      )
    } catch {
      return false
    }
  }
  return { autoTitleEligible }
}
