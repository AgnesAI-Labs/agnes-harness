import type { HostOptions } from '@agnes/host'
import { profileWakeProducer } from './profile-wake-producer.js'
import type { SharedSessionChannel } from './shared-session-channel.js'

type ManagedSessions = ReturnType<NonNullable<HostOptions['managedSessions']>>
type Action = keyof ManagedSessions

/** The caller comes from the verified row bridge; the daemon rechecks it against fresh inventory. */
export function profileSessionProducer(
  channel: SharedSessionChannel,
): NonNullable<HostOptions['managedSessions']> {
  return (caller) => {
    const call =
      (action: Action) =>
      (...args: unknown[]) =>
        channel.run('@profile', () =>
          channel.request('managed-session', { ...caller, action, args }, AbortSignal.timeout(61_000)),
        )
    return {
      start: call('start'),
      send: call('send'),
      list: call('list'),
      status: call('status'),
      events: call('events'),
      result: call('result'),
      usage: call('usage'),
      toolResult: call('toolResult'),
      interrupt: call('interrupt'),
      archive: call('archive'),
    } as ManagedSessions
  }
}

/** Shared profile coordination ports use the same authenticated channel and lifetime. */
export function profileSessionPorts(channel: SharedSessionChannel) {
  return { boundWakes: profileWakeProducer(channel), managedSessions: profileSessionProducer(channel) }
}
