// Adapted from dsh-superagent (MIT)
/** Trigger-scoped Feishu context reader over the bot CLI; what it reads goes to the model, never to intake. */
import type { MessageEvent } from '@agnes/extension-api/channel-contract'
import type { Trigger } from '../core/index.js'
import { fetchMessages, historyPages, nextPage, resolveTopic, topicPage } from './feishu-client.js'
import { admissionImageKeys, readAdmissionImage } from './feishu-image.js'
import { type FeishuIo, requireIdentity, withSignal } from './feishu-io.js'
import { channelText, feishuRef, feishuTime } from './feishu-trigger.js'
import type { ContextMessage, ThreadContext } from './kind.js'

/**
 * Retained source message reference anchoring context reads; `at` is the time `around` reads the chat by, `rootId`,
 * `parentId` and `threadId` the source message's topic root, quoted message and topic as its Trigger recorded them.
 */
export interface FeishuRef {
  triggerId: string
  chatId: string
  messageId: string
  at?: string
  rootId?: string
  parentId?: string
  threadId?: string
}

/** Resource references are anchored to an accepted trigger instead of arbitrary chat or message IDs. */
export function feishuReferences(ref: FeishuRef) {
  const read = (section: string) => `feishu/${ref.triggerId}/${section}`
  return {
    skill: 'dsh-superagent-feishu',
    message: read('message'),
    root: read('root'),
    parent: read('parent'),
    thread: read('thread'),
    around: read('around'),
  }
}

/** Validates a model-supplied resource string before any read; only `thread` and `around` take pagination cursors. */
export function feishuResource(resource: string) {
  const match = /^feishu\/([^/]+)\/(message|root|parent|thread|around)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] !== 'thread' && match[2] !== 'around')) {
    throw new Error(
      'Use feishu/<trigger-id>/message, /root, /parent, /thread or /around; follow returned next_resource for another page',
    )
  }
  return {
    triggerId: match[1]!,
    section: match[2]!,
    cursor: match[3] ? decodeURIComponent(match[3]) : undefined,
  }
}

export interface FeishuPage<M> {
  status: string
  thread_id?: string
  messages: M[]
  next_resource: string | null
}
export interface FeishuOne<M> {
  status: string
  message: M | null
}

/** Formats a channel message for model inspection; `from` is the sender's name, or their open_id without one. */
export function feishuView(event: MessageEvent): ContextMessage {
  return {
    id: event.messageId,
    from: event.sender.displayName || event.sender.userId,
    at: isoTime(event.at),
    text: channelText(event),
    ...(event.sender.kind === 'bot' ? { bot: true as const } : {}),
    ...(event.quotedMessageId ? { reply_to: event.quotedMessageId } : {}),
  }
}
function isoTime(value: string): string {
  try {
    return feishuTime(value)
  } catch {
    return value
  }
}

/** Reads messages of one chat by id, keeping only the requested ones and refusing any of another chat. */
export async function fetchFeishu(
  io: FeishuIo,
  chatId: string,
  ids: readonly string[],
): Promise<MessageEvent[]> {
  if (ids.length === 0) return []
  const events = await fetchMessages(io, chatId, ids)
  if (events.some((event) => event.chat.id !== chatId))
    throw new Error('Feishu returned a message outside the requested chat')
  return events.filter((event) => ids.includes(event.messageId))
}
/** One message of the chat by id. */
async function one(io: FeishuIo, chatId: string, id: string): Promise<FeishuOne<ContextMessage>> {
  const [event] = await fetchFeishu(io, chatId, [id])
  if (!event) throw new Error('The requested Feishu message is unavailable; do not infer its contents')
  return { status: 'available', message: feishuView(event) }
}

/** Reads up to `limit` messages of a topic in `order`, refusing any message of another chat or topic. */
export async function readTopic(
  io: FeishuIo,
  chatId: string,
  threadId: string,
  limit: number,
  order: 'asc' | 'desc' = 'asc',
): Promise<MessageEvent[]> {
  const events: MessageEvent[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const result = await topicPage(io, chatId, threadId, Math.min(50, limit - events.length), order, cursor)
    events.push(...result.messages)
    cursor = nextPage(result, seen)
  } while (cursor && events.length < limit)
  return events.slice(0, limit)
}
/** A bounded topic page; the CLI cursor is carried opaquely back to the caller. */
async function threadPage(
  io: FeishuIo,
  ref: FeishuRef,
  threadId: string,
  cursor: string | undefined,
  pageSize: number,
): Promise<FeishuPage<ContextMessage>> {
  const result = await topicPage(io, ref.chatId, threadId, pageSize, 'asc', cursor)
  const next = nextPage(result, new Set(cursor ? [cursor] : []))
  return {
    status: 'available',
    thread_id: result.thread_id,
    messages: result.messages.map(feishuView),
    next_resource: next ? `feishu/${ref.triggerId}/thread/${encodeURIComponent(next)}` : null,
  }
}

const HOUR = 3_600_000
/** Reads the chat history between two times, oldest first, refusing any message of another chat. */
export async function readHistory(
  io: FeishuIo,
  chatId: string,
  start: number,
  end: number,
): Promise<MessageEvent[]> {
  const events: MessageEvent[] = []
  for await (const page of historyPages(io, chatId, start, end)) {
    events.push(...page)
    if (events.length > 10_000) throw new Error('Feishu context history exceeds the message limit')
  }
  if (events.some((event) => event.chat.id !== chatId))
    throw new Error('Feishu history returned a message outside the requested chat')
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
/**
 * Reads the chat around `ref.at`: first the `before` messages up to and including the source message and the `after`
 * messages that follow it, within an hour either side; then pages of ten older messages within a day of the oldest one
 * shown, whose time is the cursor.
 */
async function chatAround(
  io: FeishuIo,
  ref: FeishuRef,
  cursor: string | undefined,
  before = 5,
  after = 5,
): Promise<FeishuPage<ContextMessage>> {
  const time = Date.parse(cursor ?? ref.at ?? '')
  if (!Number.isFinite(time)) throw new Error('The source Feishu message has no time to read the chat around')
  const window = cursor
    ? await readHistory(io, ref.chatId, time - 24 * HOUR, time)
    : await readHistory(io, ref.chatId, time - HOUR, time + HOUR)
  const earlierAll = window.filter((event) =>
    cursor ? Date.parse(event.at) < time : Date.parse(event.at) <= time,
  )
  const earlier = earlierAll.slice(-(cursor ? 10 : before + 1))
  const later = cursor ? [] : window.filter((event) => Date.parse(event.at) > time).slice(0, after)
  const seen = new Set<string>()
  const messages = [...earlier, ...later].filter(
    (event) => !seen.has(event.messageId) && seen.add(event.messageId),
  )
  const oldest = earlier[0]
  const next =
    earlierAll.length > earlier.length && oldest
      ? `feishu/${ref.triggerId}/around/${encodeURIComponent(new Date(Date.parse(oldest.at)).toISOString())}`
      : null
  return { status: 'available', messages: messages.map(feishuView), next_resource: next }
}

/** Reads one message, a topic page or the chat around a Trigger's source message, as its resource names it. */
export async function feishuRead(
  io: FeishuIo,
  ref: FeishuRef,
  resource: string,
  pageSize: number,
): Promise<FeishuPage<ContextMessage> | FeishuOne<ContextMessage>> {
  const request = feishuResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A Feishu source trigger is required')
  switch (request.section) {
    case 'around':
      return chatAround(io, ref, request.cursor)
    case 'thread': {
      const topic = ref.threadId ?? (await resolveTopic(io, ref.chatId, ref.rootId ?? ref.messageId))
      return topic
        ? threadPage(io, ref, topic, request.cursor, pageSize)
        : { status: 'no_thread', messages: [], next_resource: null }
    }
    case 'root':
      return ref.rootId ? one(io, ref.chatId, ref.rootId) : { status: 'no_root', message: null }
    case 'parent':
      return ref.parentId ? one(io, ref.chatId, ref.parentId) : { status: 'no_parent', message: null }
    default:
      return one(io, ref.chatId, ref.messageId)
  }
}
function sourceRef(trigger: Trigger): FeishuRef {
  const ref = feishuRef(trigger)
  if (!ref) throw new Error('A Feishu source trigger is required')
  return ref
}
/** The Feishu kind's context reader over the Source's currently verified bot CLI. */
export const feishuThreadContext = (io: () => FeishuIo): ThreadContext<{ readPageSize: number }> => ({
  messageId: (trigger) => String(trigger.meta.messageId ?? ''),
  read: async (_commands, trigger, part, cursor, config) => {
    const ref = sourceRef(trigger)
    const reader = io()
    requireIdentity(reader, trigger.meta.botIdentity)
    const resource = `feishu/${trigger.id}/${part}${cursor ? '/' + encodeURIComponent(cursor) : ''}`
    const body = await feishuRead(reader, ref, resource, config.readPageSize)
    if (part === 'thread' && body.status === 'no_thread') {
      // Fall back to preceding chat messages when the trigger message does not belong to a topic thread.
      const around = await chatAround(reader, ref, undefined, 5, 0)
      return {
        messages: around.messages,
        body: { status: 'chat_neighbours', messages: around.messages },
        status: 'chat_neighbours',
      }
    }
    const messages = 'messages' in body ? body.messages : body.message ? [body.message] : []
    const next =
      'next_resource' in body && body.next_resource
        ? decodeURIComponent(body.next_resource.split('/').at(-1)!)
        : undefined
    return { messages, next, body: { ...body }, status: body.status }
  },
  images: admissionImageKeys,
  image: (sink, _commands, trigger, message, key, _stateDir, signal) => {
    requireIdentity(io(), trigger.meta.botIdentity)
    return readAdmissionImage(
      sink,
      withSignal(io(), signal),
      { ...sourceRef(trigger), messageId: message.id },
      message.text,
      key,
    )
  },
})
