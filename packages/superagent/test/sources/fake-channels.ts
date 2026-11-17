import type { BundledAppChannels } from '@agnes/extension-api'
import type {
  Attachment,
  ChannelEvent,
  ChannelMessage,
  ChatTarget,
  MessageEvent,
} from '@agnes/extension-api/channel-contract'

type Feature = 'messages' | 'threads' | 'history' | 'chats' | 'members'
export const ALL_READS: Record<Feature, boolean> = {
  messages: true,
  threads: true,
  history: true,
  chats: true,
  members: true,
}
/** A host error as the bundled-app channels throw it: `message` names it, `data.code` the case. */
export const rpc = (name: string, code = name) => ({ code: -32000, message: name, data: { code } })

/** A Feishu message as the channel delivers it. */
export function message(
  id: string,
  fields: {
    chat?: string
    at?: string | number
    text?: string
    sender?: string
    name?: string
    bot?: boolean
    mentioned?: boolean
    thread?: string
    quoted?: string
    attachments?: Attachment[]
    eventId?: string
    direct?: boolean
  } = {},
): MessageEvent {
  const at = fields.at ?? '2026-11-14T08:00:00.000Z'
  return {
    kind: 'message',
    eventId: fields.eventId ?? `ev-${id}`,
    accountId: 'cli_app',
    chat: {
      id: fields.chat ?? 'oc_team',
      type: fields.direct ? 'dm' : 'group',
      ...(fields.thread ? { threadId: fields.thread } : {}),
    },
    sender: {
      userId: fields.sender ?? 'ou_alice',
      ...(fields.name ? { displayName: fields.name } : {}),
      kind: fields.bot ? 'bot' : 'user',
      raw: {},
    },
    at: typeof at === 'number' ? new Date(at).toISOString() : at,
    messageId: id,
    text: fields.text ?? `text of ${id}`,
    attachments: fields.attachments ?? [],
    mentions: { bot: fields.mentioned ?? false, replyToBot: false, quoteBot: false },
    ...(fields.quoted ? { quotedMessageId: fields.quoted } : {}),
  }
}

/** The plugin id of the fake channel row. */
export const PLUGIN = 'ext:acme/feishu/main'
/**
 * In-memory bundled-app channels for one channel instance, checked the way the host checks them: an instance that is
 * not running refuses `subscribe` and `claimInstance` with `CHANNEL_UNAVAILABLE`, an instance in use refuses a whole
 * claim with `state.claimRefusal`, an undeclared read is `CAPABILITY_DENIED` before its arguments are looked at, and
 * malformed arguments are `INVALID_PARAMS`.
 */
export function fakeChannels(
  options: {
    instance?: string
    running?: boolean
    reads?: Partial<Record<Feature, boolean>>
    history?: MessageEvent[]
    members?: Record<string, { userId: string; displayName?: string }[]>
    chats?: { id: string; name?: string }[]
  } = {},
) {
  const state = {
    instance: options.instance ?? 'feishu',
    plugin: PLUGIN,
    running: options.running ?? true,
    /** The code a whole claim is refused with while set, as when the owner paired a direct chat there. */
    claimRefusal: undefined as string | undefined,
    reads: { ...ALL_READS, ...options.reads },
    history: [...(options.history ?? [])],
    members: options.members ?? {},
    chats: options.chats ?? [],
    /** What the next sends throw, in order. */
    sendErrors: [] as unknown[],
    /** Holds every send until it settles, as a slow multi-part send does. */
    sendHold: undefined as Promise<void> | undefined,
    /** The message ids the next sends return, before the counted ones. */
    nextIds: [] as string[],
  }
  const subscribers = new Map<string, (event: ChannelEvent) => void>()
  let claimant: ((event: MessageEvent) => void) | undefined
  const sent: { channel: string; target: ChatTarget; message: ChannelMessage }[] = []
  const calls: { method: string; args: unknown[] }[] = []
  let counter = 0
  const read = (feature: Feature, channel: string) => {
    if (channel !== state.instance || !state.running) throw rpc('SEMANTIC_REJECTED', 'CHANNEL_UNAVAILABLE')
    if (!state.reads[feature]) throw rpc('CAPABILITY_DENIED')
  }
  const text = (value: unknown) => typeof value === 'string' && value.length > 0
  const channels: BundledAppChannels = {
    subscribe(channel, chats, onEvent) {
      calls.push({ method: 'subscribe', args: [channel, [...chats]] })
      if (channel !== state.instance || !state.running) throw rpc('SEMANTIC_REJECTED', 'CHANNEL_UNAVAILABLE')
      for (const chat of chats) subscribers.set(chat, onEvent)
      return () => {
        calls.push({ method: 'unsubscribe', args: [channel, [...chats]] })
        for (const chat of chats) if (subscribers.get(chat) === onEvent) subscribers.delete(chat)
      }
    },
    claimInstance(channel, onEvent) {
      calls.push({ method: 'claimInstance', args: [{ ...channel }] })
      if (channel.instanceId !== state.instance || channel.pluginId !== state.plugin || !state.running)
        throw rpc('SEMANTIC_REJECTED', 'CHANNEL_UNAVAILABLE')
      if (state.claimRefusal) throw rpc('SEMANTIC_REJECTED', state.claimRefusal)
      claimant = onEvent
      return {
        release() {
          calls.push({ method: 'release', args: [{ ...channel }] })
          if (claimant === onEvent) claimant = undefined
        },
      }
    },
    async send(channel, target, message) {
      calls.push({ method: 'send', args: [channel, target, message] })
      if (channel !== state.instance || !state.running) throw rpc('SEMANTIC_REJECTED', 'CHANNEL_UNAVAILABLE')
      const error = state.sendErrors.shift()
      if (error) throw error
      await state.sendHold
      sent.push({ channel, target, message })
      return { chatId: target.chatId, messageId: state.nextIds.shift() ?? `om_sent${++counter}` }
    },
    async fetchMessages(channel, chatId, ids) {
      calls.push({ method: 'fetchMessages', args: [chatId, [...ids]] })
      read('messages', channel)
      if (!text(chatId) || !ids.every(text)) throw rpc('INVALID_PARAMS')
      return state.history.filter((event) => ids.includes(event.messageId))
    },
    async listThread(channel, chatId, threadId, opts) {
      calls.push({ method: 'listThread', args: [chatId, threadId, opts] })
      read('threads', channel)
      if (!text(chatId) || !text(threadId) || opts.limit < 1) throw rpc('INVALID_PARAMS')
      const topic = state.history
        .filter(
          (event) =>
            event.chat.id === chatId && (event.chat.threadId === threadId || event.messageId === threadId),
        )
        .sort((a, b) => (opts.order === 'asc' ? 1 : -1) * a.at.localeCompare(b.at))
      return topic.slice(0, opts.limit)
    },
    async listHistory(channel, chatId, opts) {
      calls.push({ method: 'listHistory', args: [chatId, opts] })
      read('history', channel)
      if (!text(chatId) || !(Date.parse(opts.start) <= Date.parse(opts.end))) throw rpc('INVALID_PARAMS')
      return state.history
        .filter((event) => event.chat.id === chatId && event.at >= opts.start && event.at <= opts.end)
        .sort((a, b) => a.at.localeCompare(b.at))
    },
    async listChats(channel) {
      calls.push({ method: 'listChats', args: [] })
      read('chats', channel)
      return state.chats
    },
    async listMembers(channel, chatId) {
      calls.push({ method: 'listMembers', args: [chatId] })
      read('members', channel)
      if (!text(chatId)) throw rpc('INVALID_PARAMS')
      return state.members[chatId] ?? []
    },
  }
  return {
    channels,
    state,
    sent,
    calls: (method?: string) => calls.filter((call) => !method || call.method === method),
    subscribed: () => [...subscribers.keys()],
    claimed: () => !!claimant,
    /**
     * Delivers an event as the host does: a message to the instance's claimant, else to the subscriber of its group
     * chat; false when nobody received it.
     */
    emit(event: ChannelEvent): boolean {
      if (claimant) {
        if (event.kind === 'message') claimant(structuredClone(event))
        return event.kind === 'message'
      }
      if (event.chat.type === 'dm') return false
      const subscriber = subscribers.get(event.chat.id)
      subscriber?.(structuredClone(event))
      return !!subscriber
    },
  }
}

/** Stands in for the Feishu Source's context where a test needs only its settings: the Source on `channel`. */
export const configOnly = (config: Record<string, unknown> = {}) => {
  const state = new Map<string, unknown>()
  return {
    config: () => ({ instance: 'feishu', claim: 'groups', readPageSize: 20, ...config }),
    triggers: { get: () => undefined, latest: () => undefined },
    state: {
      get: (key: string) => state.get(key),
      set: (key: string, value: unknown) => void state.set(key, value),
    },
  } as never
}
