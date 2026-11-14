/**
 * A channel instance can route one direct chat to a profile-scoped managed service. The owner pairs the
 * chat on the channel page with a one-time code, after a person approves minting it; from then on the
 * Host gives the service only the text that the paired owner sends in that chat and the owner's clicks on
 * the service's own buttons, and the service can send only to that chat. Pairings, codes and the delivery
 * ledger belong to the Host, never to the channel plugin or the service. Only a managed service whose
 * reviewed declaration sets `channelTargets: true` receives a working port. Added in 5.12.
 */

interface ChannelTargetEventBase {
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
  /**
   * 1–256 characters. Present only after the platform durably recorded the event's source and text; pass it
   * to `admitInput` as an `ownerMessage` receipt instead of the text. Redeliveries of one event carry the
   * same id. Added in 5.21.
   */
  readonly receiptId?: string
}

/** A text message the paired owner sent in the paired direct chat. Attachments and empty text never arrive. */
export interface ChannelTargetMessageEvent extends ChannelTargetEventBase {
  readonly kind: 'message'
  readonly text: string
  /** The platform id of the message this one replies to or quotes, when the channel reports it. Added in 5.13. */
  readonly quotedMessageId?: string
}

/**
 * The paired owner clicked a button on a message this service sent; `messageId` is the id its `send`
 * returned. The Host keeps no button list: check `actionId` against what that message offered. Added in 5.13.
 */
export interface ChannelTargetActionEvent extends ChannelTargetEventBase {
  readonly kind: 'action'
  readonly actionId: string
}

export type ChannelTargetEvent = ChannelTargetMessageEvent | ChannelTargetActionEvent

/**
 * A button on a sent message: `id` is 1–64 of `[A-Za-z0-9:_-]` and unique within the message, `label` is
 * 1–40 characters without a line break. Added in 5.13.
 */
export interface ChannelTargetAction {
  readonly id: string
  readonly label: string
  readonly style?: 'primary' | 'default' | 'danger'
}

/**
 * What one `send` carries. Without `actions` it is one text message, `title` (1–100 characters, no line
 * break) as a bold first line. With 1–6 `actions` it is a card; a channel without cards gets numbered text.
 */
export interface ChannelTargetSend {
  readonly deliveryKey: string
  readonly text: string
  readonly title?: string
  readonly actions?: readonly ChannelTargetAction[]
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
  /** The most text one send's `text` may carry; the title line and, without cards, the button list are reserved. */
  readonly textChars: number
}

/**
 * Errors carry a fixed `data.code`: `NOT_PAIRED`, `TOO_LARGE`, `INVALID_PARAMS` and `CAPABILITY_DENIED` are final, retrying
 * does not help; `CHANNEL_UNAVAILABLE` and a platform failure may succeed later.
 */
export interface ManagedChannelTargets {
  pairing(): Promise<ChannelPairing | undefined>
  /** One handler per service; it is dropped when the resource exits. A throw makes the Host retry a few times. */
  onEvent(handler: (event: ChannelTargetEvent) => Promise<void>): void
  /** Called after this service's pairing was made or removed. Only a hint: read `pairing()` again. */
  onPairingChange(handler: () => void): void
  /** One platform message per call. The chat always comes from the pairing; repeating a key never sends twice. */
  send(pairingId: string, input: ChannelTargetSend): Promise<{ messageId: string }>
  /** Observe native human questions and approvals of a session owned by this service. */
  watchSession(pairingId: string, sessionId: string): Promise<void>
  /** Replace a message this service delivered to the current pairing. No new destination is accepted. */
  update(pairingId: string, messageId: string, input: Omit<ChannelTargetSend, 'deliveryKey'>): Promise<void>
  delivery(pairingId: string, deliveryKey: string): Promise<ChannelDelivery>
  unpair(pairingId: string): Promise<void>
}
