import type {
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  MessageEvent,
  MessageRef,
} from './channel-contract.js'

/**
 * Group-chat access for a bundled application runtime, through the owner's running channel
 * instances (since 5.19). `channel` is a channel instance id; the Host joins adapter pages.
 *
 * - `subscribe` claims group chats of one instance: their events go only to `onEvent` and never
 *   to session routing. Direct chats are never routed to a subscriber. A platform redelivery of
 *   a recent event is dropped while the subscription lives. Unsubscribe before changing the set.
 * - `send` is split and throttled as a session reply.
 *
 * Errors (JSON-RPC errors; `data.code` names the case):
 * - `CAPABILITY_DENIED`: the grant is no longer current, or the adapter does not declare the read
 *   in `capabilities().read`. Subscriptions of a stale grant end on their own.
 * - `SEMANTIC_REJECTED` `CHANNEL_UNAVAILABLE`: no running instance has that id (or two channel rows
 *   use it); retry once the channel row is running.
 * - `SEMANTIC_REJECTED` `CHANNEL_CHAT_CLAIMED`: a requested chat already has a consumer, another
 *   subscriber or a session the owner bound to it; nothing is claimed.
 * - `SEMANTIC_REJECTED` `CHANNEL_READ_INVALID`, `CHANNEL_CURSOR_STALLED`, `CHANNEL_READ_TOO_LARGE`:
 *   the adapter returned a malformed page, repeated a cursor, or exceeded the page bound.
 * - `INVALID_PARAMS`: malformed arguments.
 */
export interface BundledAppChannels {
  subscribe(channel: string, chats: readonly string[], onEvent: (event: ChannelEvent) => void): () => void
  send(channel: string, target: ChatTarget, message: ChannelMessage): Promise<MessageRef>
  fetchMessages(channel: string, chatId: string, ids: readonly string[]): Promise<MessageEvent[]>
  listThread(
    channel: string,
    chatId: string,
    threadId: string,
    opts: { order: 'asc' | 'desc'; limit: number },
  ): Promise<MessageEvent[]>
  /** `start` and `end` are ISO timestamps. */
  listHistory(channel: string, chatId: string, opts: { start: string; end: string }): Promise<MessageEvent[]>
  listChats(channel: string): Promise<{ id: string; name?: string }[]>
  listMembers(channel: string, chatId: string): Promise<{ userId: string; displayName?: string }[]>
}

/**
 * Host-private authority for a release-whitelisted bundled application. Release assembly alone
 * decides who receives it; package code, manifests and configuration cannot request or replace it.
 * Every member stops working when the package is disabled or its activation changes. Added in 5.18.
 */
export interface BundledAppGrant {
  /** Platform-chosen private directory, stable for this package in this profile. */
  readonly stateDirectory: string
  /** Owner-level local SDK client with a fixed client id. Typed `unknown` here because this package
   * does not depend on the SDK; narrow it with the SDK's client type. Closed when the grant ends. */
  readonly client: unknown
  readonly channels: BundledAppChannels
  /** Throws CAPABILITY_DENIED once the package is disabled or its activation is replaced. */
  assertCurrent(): void
}
