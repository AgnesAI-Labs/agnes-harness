import type { HostOptions } from '@agnes/host'
import { profileWakeProducer } from './profile-wake-producer.js'
import type { SharedSessionChannel } from './shared-session-channel.js'

type HostManagedSessions = ReturnType<NonNullable<HostOptions['managedSessions']>>
type Action = keyof Omit<HostManagedSessions, 'admitResolved'>

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
      admitInput: call('admitInput'),
      inputResult: call('inputResult'),
      // The Host's receipt resolution rides beside `args`, never inside them.
      admitResolved: (sessionId, input, resolution) =>
        channel.run('@profile', () =>
          channel.request(
            'managed-session',
            { ...caller, action: 'admitInput', args: [sessionId, input], resolution },
            AbortSignal.timeout(61_000),
          ),
        ),
    } as HostManagedSessions
  }
}

/** Shared profile coordination ports use the same authenticated channel and lifetime. */
export function profileSessionPorts(channel: SharedSessionChannel) {
  const channelInteractions: NonNullable<HostOptions['channelInteractions']> = (caller) => ({
    surface: (params, credential) =>
      channel.run('@profile', () =>
        channel.request(
          'channel-interaction',
          { caller, kind: 'surface', params, credential },
          AbortSignal.timeout(30_000),
        ),
      ) as ReturnType<ReturnType<NonNullable<HostOptions['channelInteractions']>>['surface']>,
    approval: (params, credential) =>
      channel.run('@profile', () =>
        channel.request(
          'channel-interaction',
          { caller, kind: 'approval', params, credential },
          AbortSignal.timeout(30_000),
        ),
      ) as ReturnType<ReturnType<NonNullable<HostOptions['channelInteractions']>>['approval']>,
  })
  return {
    channelInteractions,
    boundWakes: profileWakeProducer(channel),
    managedSessions: profileSessionProducer(channel),
  }
}
