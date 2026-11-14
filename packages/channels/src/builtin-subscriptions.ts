import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  MessageRef,
} from './adapter.js'
import { degrade } from './degrade.js'

const READS = ['fetchMessages', 'listThread', 'listHistory', 'listChats', 'listMembers'] as const

/** The running adapter of one instance as the Host sees it: sends and only the reads it implements. */
export type ChannelSubscriptionLink = Partial<Pick<ChannelAdapter, (typeof READS)[number]>> & {
  connected(): boolean
  capabilities(): ChannelCapabilities
  send(target: ChatTarget, message: ChannelMessage): Promise<MessageRef>
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
  const claims = (event: ChannelEvent) => event.chat.type !== 'dm' && port.claimed(instanceId, event.chat.id)
  return {
    claims,
    intercept(event: ChannelEvent): boolean {
      if (!claims(event)) return false
      port.deliver(instanceId, event)
      return true
    },
    attach(adapter: ChannelAdapter, connected: () => boolean): () => void {
      const link: ChannelSubscriptionLink = {
        connected,
        capabilities: () => adapter.capabilities(),
        send: (target, message) => adapter.send(target, degrade(message, adapter.capabilities()).msg),
      }
      for (const name of READS) {
        const read = adapter[name]
        if (typeof read === 'function') Object.assign(link, { [name]: read.bind(adapter) })
      }
      return port.attach(instanceId, link)
    },
  }
}
