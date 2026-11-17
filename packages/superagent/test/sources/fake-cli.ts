/** Synthetic CLI responses, independent from AGH channels. No real executable or credentials. */
import type { MessageEvent } from '@agnes/extension-api/channel-contract'
import { vi } from 'vitest'
import type { Trigger } from '../../src/core/index.js'
import { botIdentity } from '../../src/feishu-setup.js'
import type { Commands } from '../../src/infra/commands.js'
import { type FeishuIo, feishuLink } from '../../src/sources/feishu-io.js'
import type { SourceContext } from '../../src/sources/host.js'
import { testDeployment } from '../fixtures/deployment.js'

export const BOT = {
  cli: '/synthetic/lark-bot',
  appId: 'cli_app',
  botId: 'ou_bot',
  brand: 'feishu' as const,
  name: 'Test bot',
}
export const IDENTITY = botIdentity(BOT)
export function bound<T extends Trigger>(trigger: T): T {
  trigger.meta.botIdentity = IDENTITY
  if (trigger.channel) trigger.channel.address.botIdentity = IDENTITY
  return trigger
}
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
    direct?: boolean
    eventId?: string
    attachments?: MessageEvent['attachments']
  } = {},
): MessageEvent {
  return {
    kind: 'message',
    eventId: fields.eventId ?? `ev-${id}`,
    accountId: BOT.appId,
    chat: {
      id: fields.chat ?? 'oc_team',
      type: fields.direct ? 'dm' : 'group',
      ...(fields.thread ? { threadId: fields.thread } : {}),
    },
    sender: {
      userId: fields.sender ?? 'ou_alice',
      kind: fields.bot ? 'bot' : 'user',
      raw: {},
      ...(fields.name ? { displayName: fields.name } : {}),
    },
    at:
      typeof fields.at === 'number'
        ? new Date(fields.at).toISOString()
        : (fields.at ?? '2026-11-14T08:00:00.000Z'),
    messageId: id,
    text: fields.text ?? `text of ${id}`,
    attachments: fields.attachments ?? [],
    mentions: { bot: fields.mentioned ?? false, replyToBot: false, quoteBot: false },
    ...(fields.quoted ? { quotedMessageId: fields.quoted } : {}),
  }
}
export const cliMessage = (m: MessageEvent) => ({
  message_id: m.messageId,
  chat_id: m.chat.id,
  content: m.text,
  create_time: m.at,
  msg_type: 'text',
  sender: {
    id: m.sender.userId,
    sender_type: m.sender.kind,
    ...(m.sender.displayName ? { name: m.sender.displayName } : {}),
  },
  mentions: m.mentions.bot ? [{ id: BOT.botId }] : [],
  ...(m.quotedMessageId ? { parent_id: m.quotedMessageId } : {}),
  ...(m.chat.threadId ? { thread_id: m.chat.threadId } : {}),
})
export const liveEvent = (m: MessageEvent) => ({
  ...cliMessage(m),
  sender_id: m.sender.userId,
  sender_type: m.sender.kind,
  chat_type: m.chat.type === 'dm' ? 'p2p' : 'group',
})
export function fakeCli(
  options: {
    history?: MessageEvent[]
    chats?: { id: string; name?: string }[]
    members?: Record<string, { userId: string; displayName?: string }[]>
  } = {},
) {
  const state = {
    history: [...(options.history ?? [])],
    chats: options.chats ?? [],
    members: options.members ?? {},
    sendErrors: [] as unknown[],
    nextIds: [] as string[],
  }
  const calls: string[][] = [],
    sent: { args: string[]; input: string | undefined }[] = []
  const lark = vi.fn(async (args: string[], _cwd?: string, input?: string): Promise<unknown> => {
    calls.push(args)
    const flag = (key: string) => args[args.indexOf(key) + 1]
    const slice = <T>(items: T[]) => {
      const offset = Number(args.includes('--page-token') ? flag('--page-token') : 0),
        size = Number(flag('--page-size') ?? 50)
      return {
        items: items.slice(offset, offset + size),
        has_more: items.length > offset + size,
        page_token: String(offset + size),
      }
    }
    if (args[1] === '+messages-mget')
      return {
        messages: state.history
          .filter((m) => flag('--message-ids')!.split(',').includes(m.messageId))
          .map(cliMessage),
      }
    if (args[1] === '+threads-messages-list') {
      const messages = state.history
        .filter((m) => m.chat.threadId === flag('--thread'))
        .sort((a, b) => (flag('--order') === 'desc' ? -1 : 1) * a.at.localeCompare(b.at))
      const page = slice(messages)
      return {
        thread_id: flag('--thread'),
        messages: page.items.map(cliMessage),
        has_more: page.has_more,
        page_token: page.page_token,
      }
    }
    if (args[0] === 'api' && args[2] === '/open-apis/im/v1/messages') {
      const params = JSON.parse(flag('--params')!)
      const messages = state.history
        .filter(
          (m) =>
            m.chat.id === params.container_id &&
            Date.parse(m.at) >= Number(params.start_time) * 1000 &&
            Date.parse(m.at) <= Number(params.end_time) * 1000,
        )
        .sort((a, b) => a.at.localeCompare(b.at))
      const offset = Number(params.page_token ?? 0)
      return {
        items: messages
          .slice(offset, offset + params.page_size)
          .map((m) => ({ ...cliMessage(m), body: { content: JSON.stringify({ text: m.text }) } })),
        has_more: messages.length > offset + params.page_size,
        page_token: String(offset + params.page_size),
      }
    }
    if (args[1] === '+chat-list') {
      const page = slice(state.chats)
      return {
        chats: page.items.map((c) => ({ chat_id: c.id, name: c.name })),
        has_more: page.has_more,
        page_token: page.page_token,
      }
    }
    if (args[1] === '+chat-members-list')
      return {
        users: (state.members[flag('--chat-id')!] ?? []).map((u) => ({
          member_id: u.userId,
          name: u.displayName,
        })),
        has_more: false,
      }
    if (args[1] === '+messages-reply') {
      const error = state.sendErrors.shift()
      if (error) throw error
      sent.push({ args, input })
      return { message_id: state.nextIds.shift() ?? `om_reply${sent.length}` }
    }
    throw new Error(`Unexpected fake CLI command ${args.slice(0, 3).join(' ')}`)
  })
  const commands = {
    lark,
    withSignal() {
      return this
    },
  } as unknown as Commands
  const values = new Map<string, unknown>()
  const context = {
    commands,
    deployment: { ...testDeployment(), feishu: BOT },
    configured: () => true,
    config: () => ({ cli: BOT.cli, readPageSize: 20 }),
    triggers: { get: () => undefined, latest: () => undefined },
    state: {
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    },
  } as unknown as SourceContext
  const link = feishuLink()
  link.context = context
  const io: FeishuIo = { commands, bot: BOT, stateDir: '/synthetic', assertCurrent() {} }
  return { state, calls, sent, lark, commands, context, link, io }
}
