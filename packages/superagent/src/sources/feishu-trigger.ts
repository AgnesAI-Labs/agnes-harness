// Adapted from dsh-superagent (MIT)
/** Normalizes the Feishu channel's messages, live or read back, into domain Triggers. */
import type { MessageEvent } from '@agnes/extension-api/channel-contract'
import { z } from 'zod'
import { type ChannelRef, key, type Trigger } from '../core/index.js'
import type { FeishuRef } from './feishu-read.js'

export const SOURCE = 'feishu'
/** Constructs a Feishu reply channel address; records `direct` explicitly because both group and direct chat IDs start with `oc_`. */
export const feishuChannel = (chatId: string, messageId: string, direct = false): ChannelRef => ({
  source: SOURCE,
  thread: `feishu:${chatId}`,
  address: { chatId, messageId, ...(direct ? { direct: 'true' } : {}) },
})
/** A Feishu message in the shape Triggers are made from; `channelEvent` brings a channel message into it. */
const EventSchema = z.object({
  message_id: z.string(),
  chat_id: z.string(),
  chat_type: z.enum(['p2p', 'group']),
  sender_id: z.string(),
  sender_type: z.enum(['user', 'bot']),
  content: z.string(),
  create_time: z.string(),
  mentions: z
    .array(z.object({ id: z.string(), key: z.string().optional(), name: z.string().optional() }))
    .default([]),
  root_id: z.string().optional(),
  parent_id: z.string().optional(),
  thread_id: z.string().optional(),
  message_app_link: z.url().optional(),
})
export type FeishuEvent = z.infer<typeof EventSchema>
export const feishuThreadId = (chatId: string, rootId: string | undefined, messageId: string): string =>
  `${chatId}:${rootId ?? messageId}`
/** Deterministic trigger ID for a Feishu message; every read path for this message produces the same ID. */
export const feishuTriggerId = (messageId: string): string => key('feishu', messageId)
export const withMentionNames = (
  text: string,
  mentions: { key?: string | undefined; name?: string | undefined }[],
): string =>
  mentions.reduce(
    (result, mention) =>
      mention.key && mention.name ? result.replaceAll(mention.key, `@${mention.name}`) : result,
    text,
  )
/**
 * Parses a Feishu message timestamp into an ISO-8601 string: live events and the history API return epoch milliseconds as a
 * string, whereas topic/thread pages return a local timestamp string such as `2026-09-11 12:00`.
 */
export function feishuTime(value: string): string {
  const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`Unreadable Feishu message time: ${value}`)
  return new Date(time).toISOString()
}
/** Converts a normalized Feishu event into a Trigger, returning undefined for messages sent by the bot itself. */
export function feishuTrigger(input: unknown, botId: string, botAppId: string): Trigger | undefined {
  const event = EventSchema.parse(input)
  if (event.sender_id === botId || event.sender_id === botAppId) return
  const direct = event.chat_type === 'p2p'
  const mentioned = event.mentions.some((mention) => mention.id === botId || mention.id === botAppId)
  const thread = feishuThreadId(event.chat_id, event.root_id, event.message_id)
  return {
    id: feishuTriggerId(event.message_id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: event.sender_id },
    human: event.sender_type === 'user',
    ...(direct ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
    at: feishuTime(event.create_time),
    text: withMentionNames(event.content, event.mentions),
    channel: feishuChannel(event.chat_id, event.message_id, direct),
    ...(event.message_app_link ? { url: event.message_app_link } : {}),
    meta: {
      chatId: event.chat_id,
      messageId: event.message_id,
      direct,
      mentioned,
      ...(event.root_id ? { rootId: event.root_id } : {}),
      ...(event.parent_id ? { parentId: event.parent_id } : {}),
      ...(event.thread_id ? { threadId: event.thread_id } : {}),
    },
  }
}
export const feishuParent = (trigger: Trigger): string | undefined =>
  trigger.source === SOURCE && typeof trigger.meta.parentId === 'string'
    ? feishuTriggerId(trigger.meta.parentId)
    : undefined
export function feishuRef(trigger: Trigger): FeishuRef | undefined {
  const meta = trigger.meta as {
    chatId?: string
    messageId?: string
    rootId?: string
    parentId?: string
    threadId?: string
  }
  if (trigger.source !== SOURCE || !meta.chatId || !meta.messageId) return undefined
  return {
    triggerId: trigger.id,
    chatId: meta.chatId,
    messageId: meta.messageId,
    at: trigger.at,
    ...(meta.rootId ? { rootId: meta.rootId } : {}),
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    ...(meta.threadId ? { threadId: meta.threadId } : {}),
  }
}

/**
 * Stands for the bot in a channel message's mentions: the channel says whether the bot was mentioned, not under which
 * id, and the bot's own id is known only once one of its replies came back.
 */
export const BOT_MENTION = '\u0000bot'
/** The key an image attachment of a message is read by: its 1-based position among the message's attachments. */
export const imageKey = (position: number): string => `img_att_${position}`
export const IMAGE_KEY = /^img_att_([1-9][0-9]*)$/
/** A message's text followed by a marker for each image attachment, which assessments read by its key. */
export function channelText(event: Pick<MessageEvent, 'text' | 'attachments'>): string {
  const images = event.attachments.flatMap((attachment, index) =>
    attachment.mime.startsWith('image/') ? [`[image ${imageKey(index + 1)}]`] : [],
  )
  return [event.text, ...images].filter(Boolean).join('\n')
}
/**
 * Brings a channel message into the Trigger input shape. `root` is the first message of its topic or reply chain as the
 * Source resolved it (the message itself when it starts one); the quoted message is its parent.
 */
export function channelEvent(event: MessageEvent, root: string): FeishuEvent {
  return {
    message_id: event.messageId,
    chat_id: event.chat.id,
    chat_type: event.chat.type === 'dm' ? 'p2p' : 'group',
    sender_id: event.sender.userId,
    sender_type: event.sender.kind === 'bot' ? 'bot' : 'user',
    content: channelText(event),
    create_time: event.at,
    mentions: event.mentions.bot ? [{ id: BOT_MENTION }] : [],
    ...(root !== event.messageId ? { root_id: root } : {}),
    ...(event.quotedMessageId ? { parent_id: event.quotedMessageId } : {}),
    ...(event.chat.threadId ? { thread_id: event.chat.threadId } : {}),
  }
}
/**
 * The Trigger of a channel message, or undefined for a message of the bot itself (`self`, the bot's sender id once
 * known). The Trigger is the one a message of the same content always made: same id, Thread, actor and text.
 */
export const messageTrigger = (event: MessageEvent, root: string, self = ''): Trigger | undefined =>
  feishuTrigger(channelEvent(event, root), self || BOT_MENTION, BOT_MENTION)
