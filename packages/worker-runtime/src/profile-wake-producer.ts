import type { HostOptions } from '@agnes/host'
import type { BoundWakeReceipt } from '@agnes/protocol'
import type { SharedSessionChannel } from './shared-session-channel.js'

/** Owner is injected by the verified row bridge, and rechecked by the daemon's queue owner. */
export function profileWakeProducer(channel: SharedSessionChannel): NonNullable<HostOptions['boundWakes']> {
  return (owner, integrity) => ({
    enqueue: async (input) =>
      channel.run('@profile', () =>
        channel.request(
          'bound-wake',
          { owner, integrity, action: 'enqueue', input },
          AbortSignal.timeout(31000),
        ),
      ) as Promise<BoundWakeReceipt>,
    read: async (wakeId) =>
      channel.run('@profile', () =>
        channel.request(
          'bound-wake',
          { owner, integrity, action: 'read', wakeId },
          AbortSignal.timeout(31000),
        ),
      ) as Promise<BoundWakeReceipt>,
  })
}
