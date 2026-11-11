/**
 * A channel instance can route one direct chat to a profile-scoped managed service. The owner pairs the
 * chat on the channel page with a one-time code, after a person approves minting it; from then on the
 * Host gives the service only the text that the paired owner sends in that chat, and the service can send
 * text only to that chat. Pairings, codes and the delivery ledger belong to the Host, never to the channel
 * plugin or the service. Only a managed service whose reviewed declaration sets `channelTargets: true`
 * receives a working port. Added in 5.12.
 */

/** A text message the paired owner sent in the paired direct chat. Attachments and empty text never arrive. */
export interface ChannelTargetEvent {
  readonly kind: 'message'
  /** The platform verified the sender as the paired owner. */
  readonly origin: 'owner'
  readonly pairingId: string
  readonly instanceId: string
  /** Stable across redeliveries: deduplicate on it. */
  readonly eventId: string
  readonly messageId: string
  readonly at: string
  readonly chat: { readonly id: string; readonly type: 'dm' }
  readonly sender: { readonly userId: string }
  readonly text: string
}

/**
 * What became of a send. `pending`: a send with this key is running in this Host process. `unknown`: no
 * record, a send cut off by a restart, or one the platform failed in a way that may still have delivered
 * it; sending the same key again is the recovery. `failed` is reserved and not returned yet.
 */
export type ChannelDelivery =
  | { readonly state: 'delivered'; readonly messageId: string }
  | { readonly state: 'pending' }
  | { readonly state: 'failed' }
  | { readonly state: 'unknown' }

/** The pairing of the calling service, read fresh on every call. */
export interface ChannelPairing {
  readonly id: string
  readonly instanceId: string
  /** The channel provider id, for example the platform name the channel plugin registered. */
  readonly provider: string
  readonly userId: string
  readonly chatId: string
  /** The owner's display name as the platform gave it, at most 128 characters. */
  readonly label: string
  /** Whether the channel instance is connected in this Host now. A send while false is refused. */
  readonly running: boolean
  /** The longest text one send accepts. */
  readonly textChars: number
}

/**
 * Errors carry a fixed `data.code`: `NOT_PAIRED`, `TOO_LARGE` and `CAPABILITY_DENIED` are final, retrying
 * does not help; `CHANNEL_UNAVAILABLE` and a platform failure may succeed later.
 */
export interface ManagedChannelTargets {
  pairing(): Promise<ChannelPairing | undefined>
  /** One handler per service; it is dropped when the resource exits. A throw makes the Host retry a few times. */
  onEvent(handler: (event: ChannelTargetEvent) => Promise<void>): void
  /** Called after this service's pairing was made or removed. Only a hint: read `pairing()` again. */
  onPairingChange(handler: () => void): void
  /** One platform message per call. The chat always comes from the pairing; repeating a key never sends twice. */
  send(pairingId: string, input: { deliveryKey: string; text: string }): Promise<{ messageId: string }>
  delivery(pairingId: string, deliveryKey: string): Promise<ChannelDelivery>
  unpair(pairingId: string): Promise<void>
}
