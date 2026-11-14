import type { BundledAppChannels } from '@agnes/extension-api'
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
  /** Whether the owner paired a direct chat of this instance, or bound a session to any of its chats. */
  occupied(): boolean
}

/**
 * The port one channel row's bridge uses: it attaches its adapters and asks which instance or group is
 * claimed. A whole-instance claim covers every chat of the instance, direct chats included.
 */
export interface BundledAppChannelBridge {
  attach(instanceId: string, link: BundledAppChannelLink): () => void
  claimedInstance(instanceId: string): boolean
  claimed(instanceId: string, chatId: string): boolean
  /** To the instance's claimant first, else to the group's subscriber. */
  deliver(instanceId: string, event: ChannelEvent): void
}

/** The grant holder. A subscription and every call last only while `assertCurrent` passes. */
export type BundledAppCaller = { assertCurrent(): void; signal?: AbortSignal }

type Subscription = {
  /** The channel row whose instance the subscriber claimed; only that row may route to it. */
  channel: string
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
const claimedError = () => rpcError('SEMANTIC_REJECTED', { code: 'CHANNEL_CLAIMED' })
/** Hands `event` to its consumer once per recent `accountId`/`eventId`; a consumer failure stays here. */
function handOver(consumer: Subscription, event: ChannelEvent): void {
  const id = `${event.accountId}\0${event.eventId}`
  if (consumer.seen.has(id)) return
  consumer.seen.add(id)
  if (consumer.seen.size > SEEN_EVENTS) {
    const [oldest] = consumer.seen
    consumer.seen.delete(oldest as string)
  }
  try {
    consumer.onEvent(structuredClone(event))
  } catch {
    // A consumer failure must not break the channel or reach the platform.
  }
}

/**
 * The profile's claims of channel instances and group chats by bundled apps, and the running adapters
 * of every channel row. An instance claimed whole has no other consumer; a group has at most one
 * subscriber; a stale or aborted claimant loses its claims.
 */
export class BundledAppChannelHub {
  private readonly links = new Map<string, Map<string, BundledAppChannelLink>>()
  private readonly claims = new Map<string, Subscription>()
  /** Whole-instance claims, by channel row and instance id; only message events reach them. */
  private readonly instances = new Map<string, Subscription>()
  /** The plugin id (row id) of each channel row that named one. */
  private readonly plugins = new Map<string, string>()

  /**
   * `channel` names the channel row and `pluginId` its plugin's row id, by which a whole instance is
   * claimed; instances are still addressed by their own ids.
   */
  bridge(channel: string, pluginId?: string): BundledAppChannelBridge {
    if (pluginId) this.plugins.set(channel, pluginId)
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
      claimedInstance: (instanceId) => !!this.liveInstance(channel, instanceId),
      // Another row running an instance with the same id must neither see nor feed this claim.
      claimed: (instanceId, chatId) =>
        !!this.liveInstance(channel, instanceId) || this.live(instanceId, chatId)?.channel === channel,
      deliver: (instanceId, event) => {
        const whole = this.liveInstance(channel, instanceId)
        if (whole) {
          if (event.kind === 'message') handOver(whole, event)
          return
        }
        const subscription = this.live(instanceId, event.chat.id)
        if (subscription?.channel === channel) handOver(subscription, event)
      },
    }
  }

  /** A connected instance, by its id. Two channel rows with the same instance id name none. */
  link(instanceId: string): BundledAppChannelLink {
    const { link } = this.attached(instanceId)
    if (!link.connected()) throw unavailable()
    return link
  }

  private attached(instanceId: string): { channel: string; link: BundledAppChannelLink } {
    const rows = this.links.get(instanceId)
    const [only] = rows?.size === 1 ? rows : []
    if (!only) throw unavailable()
    return { channel: only[0], link: only[1] }
  }

  subscribe(
    caller: BundledAppCaller,
    instanceId: string,
    chats: readonly string[],
    onEvent: (event: ChannelEvent) => void,
  ): () => void {
    const ids = [...new Set(chats)]
    const { channel, link } = this.attached(instanceId)
    if (this.liveInstance(channel, instanceId)) throw claimedError()
    // One consumer per group: another subscriber, or a session the owner bound to it, holds it.
    if (ids.some((id) => this.live(instanceId, id) || link.bound(id)))
      throw rpcError('SEMANTIC_REJECTED', { code: 'CHANNEL_CHAT_CLAIMED' })
    const subscription: Subscription = { channel, caller, onEvent, seen: new Set() }
    for (const id of ids) this.claims.set(claimKey(instanceId, id), subscription)
    // A stale or aborted caller's claims lapse on their next lookup; unsubscribing ends them now.
    return () => {
      for (const id of ids)
        if (this.claims.get(claimKey(instanceId, id)) === subscription)
          this.claims.delete(claimKey(instanceId, id))
    }
  }

  /**
   * Claims every chat of the instance `instanceId` that the channel row of `pluginId` runs. Refused
   * while any other consumer uses the instance: a claimant, a group subscriber, an owner pairing or a
   * bound session.
   */
  claimInstance(
    caller: BundledAppCaller,
    pluginId: string,
    instanceId: string,
    onEvent: (event: MessageEvent) => void,
  ): { release(): void } {
    const rows = [...(this.links.get(instanceId) ?? [])].filter(
      ([channel]) => this.plugins.get(channel) === pluginId,
    )
    const [only] = rows.length === 1 ? rows : []
    if (!only) throw unavailable()
    const [channel, link] = only
    const prefix = claimKey(instanceId, '')
    const grouped = [...this.claims].some(
      ([key, subscription]) =>
        key.startsWith(prefix) &&
        subscription.channel === channel &&
        !!this.live(instanceId, key.slice(prefix.length)),
    )
    if (this.liveInstance(channel, instanceId) || grouped || link.occupied()) throw claimedError()
    const claim: Subscription = {
      channel,
      caller,
      onEvent: onEvent as (event: ChannelEvent) => void,
      seen: new Set(),
    }
    const key = claimKey(channel, instanceId)
    this.instances.set(key, claim)
    return {
      release: () => {
        if (this.instances.get(key) === claim) this.instances.delete(key)
      },
    }
  }

  private liveInstance(channel: string, instanceId: string): Subscription | undefined {
    const key = claimKey(channel, instanceId)
    const claim = this.instances.get(key)
    if (!claim || isCurrent(claim.caller)) return claim
    this.instances.delete(key)
    return undefined
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
export function bundledAppChannels(hub: BundledAppChannelHub, caller: BundledAppCaller): BundledAppChannels {
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
    claimInstance(channel, onEvent) {
      admit()
      if (!text(channel?.pluginId) || !text(channel?.instanceId) || typeof onEvent !== 'function')
        throw invalid()
      return hub.claimInstance(caller, channel.pluginId, channel.instanceId, onEvent)
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
