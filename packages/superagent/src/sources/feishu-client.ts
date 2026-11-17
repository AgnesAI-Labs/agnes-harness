// Adapted from dsh-superagent (MIT)
/** Concrete lark-cli reads. Every page validates its returned chat/topic before exposing content. */
import type { MessageEvent } from '@agnes/extension-api/channel-contract'
import { z } from 'zod'
import type { FeishuIo } from './feishu-io.js'
import { feishuTime, withMentionNames } from './feishu-trigger.js'

export const LiveMessage = z.object({
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
})
export type CliMessage = MessageEvent & { rootId?: string; deleted?: boolean }
const Message = z.object({
  message_id: z.string(),
  chat_id: z.string(),
  content: z.string().optional(),
  create_time: z.string(),
  deleted: z.boolean().optional(),
  sender: z.object({
    id: z.string(),
    name: z.string().optional(),
    open_bot_id: z.string().optional(),
    sender_type: z.string(),
  }),
  mentions: LiveMessage.shape.mentions,
  root_id: z.string().optional(),
  parent_id: z.string().optional(),
  thread_id: z.string().optional(),
})
const History = Message.omit({ content: true }).extend({ body: z.object({ content: z.string() }).optional() })
const Page = z.object({ has_more: z.boolean().default(false), page_token: z.string().optional() })
const chat = (id: string) =>
  z
    .string()
    .regex(/^oc_[A-Za-z0-9]+$/)
    .parse(id)
const topic = (id: string) =>
  z
    .string()
    .regex(/^omt?_[A-Za-z0-9_-]+$/)
    .parse(id)
const messageId = (id: string) =>
  z
    .string()
    .regex(/^om_[A-Za-z0-9_-]+$/)
    .parse(id)

export function liveMessage(input: unknown, io: Pick<FeishuIo, 'bot'>): CliMessage {
  const m = LiveMessage.parse(input)
  return {
    kind: 'message',
    eventId: m.message_id,
    accountId: io.bot.appId,
    chat: {
      id: m.chat_id,
      type: m.chat_type === 'p2p' ? 'dm' : 'group',
      ...(m.thread_id ? { threadId: m.thread_id } : {}),
    },
    sender: { userId: m.sender_id, kind: m.sender_type, raw: {} },
    messageId: m.message_id,
    at: feishuTime(m.create_time),
    text: withMentionNames(m.content, m.mentions),
    attachments: [],
    mentions: {
      bot: m.mentions.some((mention) => [io.bot.appId, io.bot.botId].includes(mention.id)),
      replyToBot: false,
      quoteBot: false,
    },
    ...(m.parent_id ? { quotedMessageId: m.parent_id } : {}),
    ...(m.root_id ? { rootId: m.root_id } : {}),
  }
}
function rendered(m: z.infer<typeof Message>, io: FeishuIo, direct = false): CliMessage {
  return {
    ...liveMessage(
      {
        ...m,
        chat_type: direct ? 'p2p' : 'group',
        content: m.content ?? '',
        sender_id: m.sender.open_bot_id ?? m.sender.id,
        sender_type: m.sender.sender_type === 'user' ? 'user' : 'bot',
      },
      io,
    ),
    ...(m.deleted ? { deleted: true } : {}),
    sender: {
      userId: m.sender.open_bot_id ?? m.sender.id,
      kind: m.sender.sender_type === 'user' ? 'user' : 'bot',
      raw: {},
      ...(m.sender.name ? { displayName: m.sender.name } : {}),
    },
  }
}
function checked(messages: CliMessage[], chatId: string, threadId?: string): CliMessage[] {
  if (messages.some((m) => m.chat.id !== chatId))
    throw new Error('Feishu returned a message outside the requested chat')
  if (threadId && messages.some((m) => m.chat.threadId && m.chat.threadId !== threadId))
    throw new Error('Feishu returned messages outside the source thread')
  return messages.filter((m) => !m.deleted)
}
export function nextPage(page: z.infer<typeof Page>, seen: Set<string>): string | undefined {
  if (!page.has_more) return undefined
  if (!page.page_token || seen.has(page.page_token)) throw new Error('Feishu pagination did not advance')
  seen.add(page.page_token)
  if (seen.size > 1000) throw new Error('Feishu pagination exceeds the page limit; narrow the time range')
  return page.page_token
}
export async function fetchMessages(
  io: FeishuIo,
  chatId: string,
  ids: readonly string[],
): Promise<CliMessage[]> {
  chat(chatId)
  ids.forEach(messageId)
  if (!ids.length) return []
  const result = z
    .object({ messages: z.array(Message) })
    .parse(await io.commands.lark(['im', '+messages-mget', '--message-ids', ids.join(','), '--no-reactions']))
  return checked(
    result.messages.map((m) => rendered(m, io)),
    chatId,
  ).filter((m) => ids.includes(m.messageId))
}
/** Resolve a ticket's retained message to its current topic, including topics created after initial intake. */
export async function resolveTopic(io: FeishuIo, chatId: string, id: string): Promise<string | undefined> {
  topic(id)
  if (id.startsWith('omt_')) return id
  const [message] = await fetchMessages(io, chatId, [id])
  const canonical = message?.chat.threadId
  return canonical
    ? z
        .string()
        .regex(/^omt_[A-Za-z0-9_-]+$/)
        .parse(canonical)
    : undefined
}
export async function topicPage(
  io: FeishuIo,
  chatId: string,
  threadId: string,
  limit: number,
  order: 'asc' | 'desc',
  cursor?: string,
) {
  chat(chatId)
  const canonical = await resolveTopic(io, chatId, threadId)
  if (!canonical) throw new Error('The source Feishu message has no readable topic')
  const args = [
    'im',
    '+threads-messages-list',
    '--thread',
    canonical,
    '--order',
    order,
    '--page-size',
    String(limit),
    '--no-reactions',
  ]
  if (cursor) args.push('--page-token', cursor)
  const result = Page.extend({ thread_id: z.string(), messages: z.array(Message) }).parse(
    await io.commands.lark(args),
  )
  if (result.thread_id !== canonical) throw new Error('Feishu returned messages outside the source thread')
  return {
    ...result,
    messages: checked(
      result.messages.map((m) => rendered(m, io)),
      chatId,
      canonical,
    ),
  }
}
export async function* historyPages(
  io: FeishuIo,
  chatId: string,
  start: number,
  end: number,
  direct = false,
) {
  chat(chatId)
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    io.assertCurrent()
    const params = {
      container_id_type: 'chat',
      container_id: chatId,
      start_time: String(Math.floor(start / 1000)),
      end_time: String(Math.ceil(end / 1000)),
      sort_type: 'ByCreateTimeAsc',
      page_size: 50,
      ...(cursor ? { page_token: cursor } : {}),
    }
    const result = Page.extend({ items: z.array(History).default([]) }).parse(
      await io.commands.lark(['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(params)]),
    )
    const messages = result.items.map((m) => {
      let content = m.body?.content ?? ''
      try {
        const parsed = JSON.parse(content) as { text?: unknown }
        if (typeof parsed.text === 'string') content = parsed.text
      } catch {
        /* system text */
      }
      return rendered({ ...m, content }, io, direct)
    })
    yield checked(messages, chatId)
    cursor = nextPage(result, seen)
  } while (cursor)
}
export async function listChats(io: FeishuIo): Promise<Record<string, string>> {
  const seen = new Set<string>(),
    names: Record<string, string> = {}
  let cursor: string | undefined
  do {
    const result = Page.extend({
      chats: z.array(z.object({ chat_id: z.string(), name: z.string().nullish() })),
    }).parse(
      await io.commands.lark([
        'im',
        '+chat-list',
        '--page-size',
        '100',
        ...(cursor ? ['--page-token', cursor] : []),
      ]),
    )
    for (const item of result.chats) if (item.name) names[item.chat_id] = item.name
    cursor = nextPage(result, seen)
  } while (cursor)
  return names
}
export async function listMembers(io: FeishuIo, chatId: string): Promise<{ id: string; name?: string }[]> {
  chat(chatId)
  const result = z
    .object({
      users: z.array(z.object({ member_id: z.string(), name: z.string().optional() })),
      has_more: z.boolean().optional(),
      truncations: z.array(z.unknown()).optional(),
    })
    .parse(
      await io.commands.lark([
        'im',
        '+chat-members-list',
        '--chat-id',
        chatId,
        '--member-types',
        'user',
        '--member-id-type',
        'open_id',
        '--page-all',
        '--page-limit',
        '1000',
        '--page-size',
        '100',
      ]),
    )
  if (result.has_more || result.truncations?.length)
    throw new Error('Feishu member list is incomplete; the allowlist is unchanged')
  return result.users.map((user) => ({ id: user.member_id, ...(user.name ? { name: user.name } : {}) }))
}
