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
  /** Whether the owner paired a direct chat or bound a session here. Such an instance cannot be claimed whole. */
  occupied(): boolean
}

/**
 * The Host port for one channel row's instances and group chats claimed by a bundled app. A claimed
 * instance's events, direct chats included, and a claimed group's events go only to the claimant and
 * never reach pairing or session binding. Group claims never cover a direct chat.
 */
export interface ChannelSubscriptionsPort {
  attach(instanceId: string, link: ChannelSubscriptionLink): () => void
  /** Synchronous, so a claim decides the route of the event being received. */
  claimedInstance(instanceId: string): boolean
  claimed(instanceId: string, chatId: string): boolean
  /** The Host hands the event to the instance's claimant first, else to the group's subscriber. */
  deliver(instanceId: string, event: ChannelEvent): void
}

/** True when the sender is marked as a bot. A sender without a kind is a user. */
export const fromBot = (event: ChannelEvent) => event.sender.kind === 'bot'

export function createSubscriptionRouter(port: ChannelSubscriptionsPort, instanceId: string) {
  const claimedInstance = () => port.claimedInstance(instanceId)
  const claimsChat = (chat: { chatId: string; chatType?: 'dm' | 'group' | 'thread' }) =>
    claimedInstance() || (chat.chatType !== 'dm' && port.claimed(instanceId, chat.chatId))
  const claims = (event: ChannelEvent) => claimsChat({ chatId: event.chat.id, chatType: event.chat.type })
  return {
    claimedInstance,
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
      occupied(): boolean
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
        occupied: () => source.occupied(),
      })
    },
  }
}
