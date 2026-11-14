import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  MessageEvent,
  MessageRef,
} from '@agnes/extension-api/channel-contract'
import { rpcError } from '@agnes/protocol'

const READ_CAPABILITY = {
  fetchMessages: 'messages',
  listThread: 'threads',
  listHistory: 'history',
  listChats: 'chats',
  listMembers: 'members',
} as const
type Read = keyof typeof READ_CAPABILITY

/**
 * One running channel instance, attached for as long as its channel row runs. `send` takes the
 * session replies' chunking and throttling; `reads` holds only the reads the current adapter has.
 */
export type BundledAppChannelLink = {
  connected(): boolean
  capabilities(): ChannelCapabilities
  send(target: ChatTarget, message: ChannelMessage): Promise<MessageRef>
  reads(): Partial<Pick<ChannelAdapter, Read>>
  /** Whether a session is bound, or being bound, to this chat. */
  bound(chatId: string): boolean
}

/** The port one channel row's bridge uses: it attaches its adapters and asks which group is claimed. */
export interface BundledAppChannelBridge {
  attach(instanceId: string, link: BundledAppChannelLink): () => void
  claimed(instanceId: string, chatId: string): boolean
  deliver(instanceId: string, event: ChannelEvent): void
}

/** The channel half of the bundled-app grant. `channel` is a channel instance id; the Host joins pages. */
export interface BundledAppChannelsApi {
  subscribe(channel: string, chats: readonly string[], onEvent: (event: ChannelEvent) => void): () => void
  send(channel: string, target: ChatTarget, message: ChannelMessage): Promise<MessageRef>
  fetchMessages(channel: string, chatId: string, ids: readonly string[]): Promise<MessageEvent[]>
  listThread(
    channel: string,
    chatId: string,
    threadId: string,
    opts: { order: 'asc' | 'desc'; limit: number },
  ): Promise<MessageEvent[]>
  listHistory(channel: string, chatId: string, opts: { start: string; end: string }): Promise<MessageEvent[]>
  listChats(channel: string): Promise<{ id: string; name?: string }[]>
  listMembers(channel: string, chatId: string): Promise<{ userId: string; displayName?: string }[]>
}

/** The grant holder. A subscription and every call last only while `assertCurrent` passes. */
export type BundledAppCaller = { assertCurrent(): void; signal?: AbortSignal }

type Subscription = {
  caller: BundledAppCaller
  onEvent: (event: ChannelEvent) => void
  /** Recently delivered `accountId`/`eventId` pairs, oldest first. */
  seen: Set<string>
}

const PAGE_SIZE = 50
const MAX_PAGES = 200
const MAX_CHATS = 256
/** Platform redeliveries of an event this recent are dropped for the live subscription. */
const SEEN_EVENTS = 1024

const unavailable = () => rpcError('SEMANTIC_REJECTED', { code: 'CHANNEL_UNAVAILABLE' })
const invalid = () => rpcError('INVALID_PARAMS')
const isCurrent = (caller: BundledAppCaller) => {
  if (caller.signal?.aborted) return false
  try {
    caller.assertCurrent()
    return true
  } catch {
    return false
  }
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * The profile's claims of channel group chats by bundled apps, and the running adapters of every
 * channel row. A group has at most one subscriber; a stale or aborted subscriber loses its claims.
 */
export class BundledAppChannelHub {
  private readonly links = new Map<string, Map<string, BundledAppChannelLink>>()
  private readonly claims = new Map<string, Subscription>()

  /** `channel` names the channel row; instances are still addressed by their own ids. */
  bridge(channel: string): BundledAppChannelBridge {
    return {
      attach: (instanceId, link) => {
        const rows = this.links.get(instanceId) ?? new Map<string, BundledAppChannelLink>()
        rows.set(channel, link)
        this.links.set(instanceId, rows)
        return () => {
          if (rows.get(channel) !== link) return
          rows.delete(channel)
          if (rows.size === 0 && this.links.get(instanceId) === rows) this.links.delete(instanceId)
        }
      },
      claimed: (instanceId, chatId) => this.live(instanceId, chatId) !== undefined,
      deliver: (instanceId, event) => {
        const subscription = this.live(instanceId, event.chat.id)
        if (!subscription) return
        const id = `${event.accountId}\0${event.eventId}`
        if (subscription.seen.has(id)) return
        subscription.seen.add(id)
        if (subscription.seen.size > SEEN_EVENTS) {
          const [oldest] = subscription.seen
          subscription.seen.delete(oldest as string)
        }
        try {
          subscription.onEvent(structuredClone(event))
        } catch {
          // A subscriber failure must not break the channel or reach the platform.
        }
      },
    }
  }

  /** A connected instance, by its id. Two channel rows with the same instance id name none. */
  link(instanceId: string): BundledAppChannelLink {
    const link = this.attached(instanceId)
    if (!link.connected()) throw unavailable()
    return link
  }

  private attached(instanceId: string): BundledAppChannelLink {
    const rows = this.links.get(instanceId)
    const link = rows?.size === 1 ? [...rows.values()][0] : undefined
    if (!link) throw unavailable()
    return link
  }

  subscribe(
    caller: BundledAppCaller,
    instanceId: string,
    chats: readonly string[],
    onEvent: (event: ChannelEvent) => void,
  ): () => void {
    const ids = [...new Set(chats)]
    const link = this.attached(instanceId)
    // One consumer per group: another subscriber, or a session the owner bound to it, holds it.
    if (ids.some((id) => this.live(instanceId, id) || link.bound(id)))
      throw rpcError('SEMANTIC_REJECTED', { code: 'CHANNEL_CHAT_CLAIMED' })
    const subscription: Subscription = { caller, onEvent, seen: new Set() }
    for (const id of ids) this.claims.set(claimKey(instanceId, id), subscription)
    // A stale or aborted caller's claims lapse on their next lookup; unsubscribing ends them now.
    return () => {
      for (const id of ids)
        if (this.claims.get(claimKey(instanceId, id)) === subscription)
          this.claims.delete(claimKey(instanceId, id))
    }
  }

  private live(instanceId: string, chatId: string): Subscription | undefined {
    const key = claimKey(instanceId, chatId)
    const subscription = this.claims.get(key)
    if (!subscription || isCurrent(subscription.caller)) return subscription
    this.claims.delete(key)
    return undefined
  }
}

const claimKey = (instanceId: string, chatId: string) => `${instanceId}\0${chatId}`

/** The grant's channel methods for one caller. Reads not declared by the adapter are CAPABILITY_DENIED. */
export function bundledAppChannels(
  hub: BundledAppChannelHub,
  caller: BundledAppCaller,
): BundledAppChannelsApi {
  const admit = () => {
    if (!isCurrent(caller)) throw rpcError('CAPABILITY_DENIED')
  }
  const running = (channel: string) => {
    admit()
    if (!text(channel)) throw invalid()
    return hub.link(channel)
  }
  const reader = <K extends Read>(channel: string, name: K): NonNullable<ChannelAdapter[K]> => {
    const link = running(channel)
    const read = link.reads()[name]
    if (link.capabilities().read?.[READ_CAPABILITY[name]] !== true || typeof read !== 'function')
      throw rpcError('CAPABILITY_DENIED')
    return read as NonNullable<ChannelAdapter[K]>
  }
  /** Joins cursor pages; a cursor that does not advance or a read past the page bound is refused. */
  const collect = async <T>(
    next: (cursor: string | undefined, remaining: number) => Promise<{ items: unknown; cursor?: string }>,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<T[]> => {
    const items: T[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await next(cursor, limit - items.length)
      admit()
      if (!Array.isArray(result?.items)) throw rpcError('SEMANTIC_REJECTED', { code: 'CHANNEL_READ_INVALID' })
      items.push(...(result.items as T[]))
      if (items.length >= limit) return items.slice(0, limit)
      if (!result.cursor) return items
      if (result.cursor === cursor) throw rpcError('SEMANTIC_REJECTED', { code: 'CHANNEL_CURSOR_STALLED' })
      cursor = result.cursor
    }
    throw rpcError('SEMANTIC_REJECTED', { code: 'CHANNEL_READ_TOO_LARGE' })
  }
  const at = (cursor: string | undefined) => (cursor ? { cursor } : {})
  return {
    subscribe(channel, chats, onEvent) {
      admit()
      if (
        !text(channel) ||
        !Array.isArray(chats) ||
        chats.length === 0 ||
        chats.length > MAX_CHATS ||
        !chats.every(text) ||
        typeof onEvent !== 'function'
      )
        throw invalid()
      return hub.subscribe(caller, channel, chats, onEvent)
    },
    async send(channel, target, message) {
      return await running(channel).send(target, message)
    },
    async fetchMessages(channel, chatId, ids) {
      const read = reader(channel, 'fetchMessages')
      if (!text(chatId) || !Array.isArray(ids) || !ids.every(text)) throw invalid()
      const events = await read(chatId, ids)
      admit()
      if (!Array.isArray(events)) throw rpcError('SEMANTIC_REJECTED', { code: 'CHANNEL_READ_INVALID' })
      return events
    },
    async listThread(channel, chatId, threadId, opts) {
      const read = reader(channel, 'listThread')
      if (
        !text(chatId) ||
        !text(threadId) ||
        (opts?.order !== 'asc' && opts?.order !== 'desc') ||
        !Number.isSafeInteger(opts.limit) ||
        opts.limit < 1
      )
        throw invalid()
      return await collect<MessageEvent>(async (cursor, remaining) => {
        const page = await read(chatId, threadId, {
          order: opts.order,
          pageSize: Math.min(PAGE_SIZE, remaining),
          ...at(cursor),
        })
        return { items: page?.events, ...at(page?.cursor) }
      }, opts.limit)
    },
    async listHistory(channel, chatId, opts) {
      const read = reader(channel, 'listHistory')
      const start = Date.parse(opts?.start)
      const end = Date.parse(opts?.end)
      if (!text(chatId) || !Number.isFinite(start) || !Number.isFinite(end) || start > end) throw invalid()
      return await collect<MessageEvent>(async (cursor) => {
        const page = await read(chatId, { start: opts.start, end: opts.end, ...at(cursor) })
        return { items: page?.events, ...at(page?.cursor) }
      })
    },
    async listChats(channel) {
      const read = reader(channel, 'listChats')
      return await collect(async (cursor) => {
        const page = await read(at(cursor))
        return { items: page?.chats, ...at(page?.cursor) }
      })
    },
    async listMembers(channel, chatId) {
      const read = reader(channel, 'listMembers')
      if (!text(chatId)) throw invalid()
      return await collect(async (cursor) => {
        const page = await read(chatId, at(cursor))
        return { items: page?.members, ...at(page?.cursor) }
      })
    },
  }
}
