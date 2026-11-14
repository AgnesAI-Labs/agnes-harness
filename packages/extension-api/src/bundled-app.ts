import type {
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  MessageEvent,
  MessageRef,
} from './channel-contract.js'

/** Group-chat access for a bundled application runtime. `channel` is a channel instance id;
 * the Host aggregates adapter pages. Calls refuse with CAPABILITY_DENIED when unavailable. */
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
