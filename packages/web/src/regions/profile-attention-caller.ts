import { type ClientProfileCaller, homeNavigation, type SessionService } from '@agnes/web-client'
import type { ProfileAttention } from './profile-attention-state.js'

/** Only this browser's initiating effect receipt opens a prompt; broadcasts populate the inbox. */
export function profileAttentionCaller(
  caller: ClientProfileCaller,
  attention: ProfileAttention,
  session: SessionService,
): ClientProfileCaller {
  return async (module, service, input, options) => {
    const page = homeNavigation.getSnapshot()
    const selected = session.sessionId
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const nativeDialog = trigger?.closest('dialog')
    const current = () =>
      homeNavigation.getSnapshot() === page &&
      session.sessionId === selected &&
      (!trigger ||
        (trigger.isConnected && !trigger.closest('[hidden]') && (!nativeDialog || nativeDialog.open)))
    const result = await caller(module, service, input, options)
    if (options?.operationId && !options.read) attention.receive(result, current, trigger)
    return result
  }
}
