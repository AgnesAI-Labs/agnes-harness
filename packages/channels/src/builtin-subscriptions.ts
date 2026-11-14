import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  MessageRef,
} from './adapter.js'
import type { Runner } from './runner/runner.js'

const READS = ['fetchMessages', 'listThread', 'listHistory', 'listChats', 'listMembers'] as const
type Reads = Partial<Pick<ChannelAdapter, (typeof READS)[number]>>

/**
 * One channel instance as the Host sees it, for as long as the instance runs, across reconnects.
 * Sends share the session replies' chunking and throttling; `reads` holds only the reads the
 * current adapter implements.
 */
export type ChannelSubscriptionLink = {
  connected(): boolean
  capabilities(): ChannelCapabilities
  send(target: ChatTarget, message: ChannelMessage): Promise<MessageRef>
  reads(): Reads
  /** Whether a session is bound, or being bound, to this chat. Such a chat cannot be claimed. */
  bound(chatId: string): boolean
}

/**
 * The Host port for one channel row's group chats claimed by a bundled app. A claimed group's events
 * go only to its subscriber and never reach session binding; direct chats are never claimed here.
 */
export interface ChannelSubscriptionsPort {
  attach(instanceId: string, link: ChannelSubscriptionLink): () => void
  /** Synchronous, so a claim decides the route of the event being received. */
  claimed(instanceId: string, chatId: string): boolean
  deliver(instanceId: string, event: ChannelEvent): void
}

/** True when the sender is marked as a bot. A sender without a kind is a user. */
export const fromBot = (event: ChannelEvent) => event.sender.kind === 'bot'

export function createSubscriptionRouter(port: ChannelSubscriptionsPort, instanceId: string) {
  const claimsChat = (chat: { chatId: string; chatType?: 'dm' | 'group' | 'thread' }) =>
    chat.chatType !== 'dm' && port.claimed(instanceId, chat.chatId)
  const claims = (event: ChannelEvent) => claimsChat({ chatId: event.chat.id, chatType: event.chat.type })
  return {
    claims,
    claimsChat,
    intercept(event: ChannelEvent): boolean {
      if (!claims(event)) return false
      port.deliver(instanceId, event)
      return true
    },
    attach(source: {
      adapter(): ChannelAdapter | undefined
      runner(): Runner | undefined
      bound(chatId: string): boolean
    }): () => void {
      const running = () => {
        const adapter = source.adapter()
        const runner = source.runner()
        if (!adapter || !runner) throw new Error('Channel adapter is not running')
        return { adapter, runner }
      }
      return port.attach(instanceId, {
        connected: () => source.runner()?.status().channel === 'connected',
        capabilities: () => running().adapter.capabilities(),
        send: (target, message) => running().runner.sendMessage(target, message, target.deliveryKey),
        reads() {
          const adapter = running().adapter
          const reads: Reads = {}
          for (const name of READS) {
            const read = adapter[name]
            if (typeof read === 'function') Object.assign(reads, { [name]: read.bind(adapter) })
          }
          return reads
        },
        bound: (chatId) => source.bound(chatId),
      })
    },
  }
}
