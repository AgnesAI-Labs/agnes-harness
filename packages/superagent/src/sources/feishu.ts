// Adapted from dsh-superagent (MIT)
/** Feishu source kind definition, policy synchronization, and the entry that starts its loops. */
import { z } from 'zod'
import { FeishuBotSchema } from '../deployment.js'
import { feishuLink, sendFeishu } from './feishu-channel.js'
import { refreshChatNames, runFeishu } from './feishu-loops.js'
import { feishuThreadContext } from './feishu-read.js'
import { feishuTriggerId, SOURCE } from './feishu-trigger.js'
import { type SourceHost, sourceContext } from './host.js'
import type { Localized, SourceKind } from './kind.js'
import type { SourceRegistry } from './registry.js'

export { backfillChat, consumerRetry, pollThreads, refreshChatNames, threadRef } from './feishu-loops.js'
export type { FeishuEvent } from './feishu-trigger.js'
export {
  feishuRef,
  feishuThreadId,
  feishuTime,
  feishuTrigger,
  feishuTriggerId,
  historyEvent,
  SOURCE,
  withMentionNames,
} from './feishu-trigger.js'

const MembersSchema = z.looseObject({
  users: z.array(z.looseObject({ member_id: z.string(), name: z.string() })),
  has_more: z.boolean(),
  truncations: z.array(z.unknown()).optional(),
})
const FeishuConfigSchema = FeishuBotSchema.extend({
  readPageSize: z.number().int().min(1).max(50).default(20),
  linkTimeoutMs: z.number().int().min(1).max(90000).default(5000),
  chats: z
    .array(
      z
        .object({
          chatId: z.string().regex(/^oc_[a-zA-Z0-9]+$/),
          name: z.string().trim().max(60).optional(),
          listen: z.enum(['mentions', 'all']),
        })
        .strict(),
    )
    .refine((chats) => new Set(chats.map((chat) => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
export const feishuKind: SourceKind<FeishuConfig> = {
  kind: SOURCE,
  refreshLabels: (host, signal) => refreshChatNames(sourceContext(host, feishuKind), signal),
  title: { zh: '飞书', en: 'Feishu' },
  description: {
    zh: '接收下列群和私聊中发给机器人的消息，补收群历史并轮询订阅的线程。',
    en: 'Receives messages to the bot in these chats and direct messages, recovers chat history and polls subscribed Threads.',
  },
  schema: FeishuConfigSchema,
  fields: [
    {
      key: 'cli',
      type: 'text',
      label: { zh: '机器人的 lark-cli', en: 'Bot lark-cli' },
      hint: {
        zh: '命令名或绝对路径，指向只允许机器人身份（strict mode bot）的 lark-cli 配置；执行器以 lark-cli 调用它。保存时读取应用和机器人，然后重启 dsh-superagent。',
        en: 'A command name or absolute path of a lark-cli configuration that allows only the bot identity (strict mode bot); the Executor calls it as lark-cli. Saving reads the app and the bot, then restarts dsh-superagent.',
      },
    },
    {
      key: 'chats',
      type: 'rows',
      label: { zh: '接收的群', en: 'Chats' },
      hint: {
        zh: '“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作，需要机器人有读取全部消息的权限。',
        en: '"@ only" receives messages that mention the bot and Threads that have Tickets; "All" also receives the rest, from which Eval may infer work under the rules; the bot needs permission to read all messages.',
      },
      columns: [
        {
          key: 'chatId',
          type: 'text',
          label: { zh: '群', en: 'Chat' },
          pattern: 'oc_[a-zA-Z0-9]+',
          choose: { zh: '选择机器人已加入的群', en: 'Choose a chat the bot has joined' },
          refresh: { zh: '刷新群列表', en: 'Refresh chats' },
        },
        {
          key: 'listen',
          type: 'select',
          label: { zh: '接收', en: 'Receive' },
          options: [
            { value: 'mentions', label: { zh: '仅 @', en: '@ only' } },
            { value: 'all', label: { zh: '全部消息', en: 'All' } },
          ],
        },
      ],
    },
    {
      key: 'otherChats',
      type: 'select',
      label: { zh: '其他群', en: 'Other chats' },
      options: [
        { value: 'none', label: { zh: '不接收', en: 'Not received' } },
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } },
      ],
      hint: {
        zh: '机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。',
        en: 'Chats the bot has joined that are not listed above. "@ only" receives messages there that mention the bot; whose messages may originate work is the Policy\'s admission.',
      },
    },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    {
      key: 'readPageSize',
      type: 'number',
      advanced: true,
      min: 1,
      max: 50,
      label: { zh: '每页消息数', en: 'Messages per page' },
      hint: {
        zh: '智能体读取线程和群历史时，每页的消息数。',
        en: 'Messages per page when agents read Threads and chat history.',
      },
    },
    {
      key: 'linkTimeoutMs',
      type: 'number',
      advanced: true,
      min: 1,
      max: 90000,
      label: { zh: '原消息链接的查询时限 / 毫秒', en: 'Original message link time limit / ms' },
      hint: {
        zh: '查询原消息链接最多等待的时间；超时后智能体改为直接读取原消息。',
        en: "How long to wait for an original message's link; after that, agents read the message itself.",
      },
    },
  ],
  health: ['feishu', 'history'],
  scope({ meta }, config) {
    if (meta.direct === true)
      return config.directMessages
        ? { listened: true, observed: false, row: 'direct' }
        : { listened: false, reason: 'direct_messages_not_allowed' }
    const chat = config.chats.find((item) => item.chatId === meta.chatId)
    if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
    return config.otherChats === 'mentions'
      ? { listened: true, observed: false, row: 'other' }
      : { listened: false, reason: 'chat_not_allowed' }
  },
  // A reply goes only to a chat the Source still receives.
  channel: {
    allowed: (address, config) =>
      feishuKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config)
        .listened,
    send: sendFeishu,
    link: feishuLink,
  },
  threadContext: feishuThreadContext,
  find: (query) => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: (trigger) =>
    typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined,
  policy: {
    unnamed: { person: { zh: '飞书用户', en: 'Feishu user' }, bot: { zh: '飞书机器人', en: 'Feishu bot' } },
    schema: z
      .object({
        allowed: z
          .array(
            z
              .object({
                id: z.string().regex(/^ou_[a-zA-Z0-9]+$/),
                name: z.string().trim().max(100).optional(),
              })
              .strict(),
          )
          .refine(
            (users) => new Set(users.map((user) => user.id)).size === users.length,
            'Duplicate open_ids',
          )
          .default([]),
        syncChat: z
          .string()
          .regex(/^(oc_[a-zA-Z0-9]+)?$/)
          .default(''),
        bots: z
          .array(
            z
              .object({
                id: z.string().regex(/^(cli|ou)_[a-zA-Z0-9]+$/),
                name: z.string().trim().max(100).optional(),
              })
              .strict(),
          )
          .refine((bots) => new Set(bots.map((bot) => bot.id)).size === bots.length, 'Duplicate bot ids')
          .optional(),
      })
      .strict(),
    fields: [
      {
        key: 'allowed',
        type: 'rows',
        label: { zh: '能发起工作的飞书用户', en: 'Feishu users who may originate work' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'open_id', en: 'open_id' }, pattern: 'ou_[a-zA-Z0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ],
      },
      {
        key: 'syncChat',
        type: 'text',
        pattern: '(oc_[a-zA-Z0-9]+)?',
        label: { zh: '同步来源群', en: 'Sync chat' },
        choose: { zh: '不同步', en: 'Do not sync' },
        hint: {
          zh: '同步时，名单变成这个群里的人：新成员加入，离开的人移除，名字取群里的名字。启动时和点同步时进行。',
          en: 'Syncing makes the list the people in this chat: new members join, people who left are removed, and names follow the chat. It runs at startup and on Sync.',
        },
      },
      {
        key: 'bots',
        type: 'rows',
        label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: {
          zh: '名单里的机器人在接收的群里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。其他机器人的消息不接收。',
          en: "Messages of a bot on this list, in chats the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket. Other bots' messages are not admitted.",
        },
        columns: [
          {
            key: 'id',
            type: 'text',
            label: { zh: 'App ID 或 open_id', en: 'App ID or open_id' },
            pattern: '(cli|ou)_[a-zA-Z0-9]+',
          },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ],
      },
    ],
    explicit: {
      zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。',
      en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.',
    },
    rows(stored) {
      const config = FeishuConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map((chat) => ({
          id: chat.chatId,
          label: chat.name || chat.chatId,
          note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: {
            listedUnaddressed: chat.listen === 'all',
            unlistedAddressed: true,
            unlistedUnaddressed: chat.listen === 'all',
          },
        })),
        {
          id: 'other',
          label: { zh: '其他群', en: 'Other chats' },
          note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: {
            listedUnaddressed: false,
            unlistedAddressed: config.otherChats === 'mentions',
            unlistedUnaddressed: false,
          },
        },
        {
          id: 'direct',
          label: { zh: '私聊', en: 'Direct messages' },
          note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: {
            listedUnaddressed: false,
            unlistedAddressed: config.directMessages,
            unlistedUnaddressed: false,
          },
        },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: (part) => !!part.syncChat,
      async run(host, part, signal) {
        const commands = sourceContext(host, feishuKind).commands.withSignal(signal)
        const chat = String(part.syncChat)
        const members = [
          'im',
          '+chat-members-list',
          '--chat-id',
          chat,
          '--member-types',
          'user',
          '--page-all',
          '--page-limit',
          '0',
        ]
        const result = MembersSchema.parse(await commands.lark(members))
        if (result.has_more || result.truncations?.length)
          throw new Error('Feishu returned an incomplete member list')
        // Preserve existing member order so policy version hashes stay stable; update names in place and append new members.
        const users = new Map(result.users.map((user) => [user.member_id, user.name]))
        const known = new Set(part.allowed.map((entry) => entry.id))
        return {
          ...part,
          allowed: [
            ...part.allowed
              .filter((entry) => users.has(entry.id))
              .map((entry) => ({ ...entry, name: users.get(entry.id)! })),
            ...result.users
              .filter((user) => !known.has(user.member_id))
              .map((user) => ({ id: user.member_id, name: user.name })),
          ],
        }
      },
    },
  },
  environment: {
    variables: [
      {
        key: 'DSH_SUPERAGENT_FEISHU_BOT',
        description: { zh: '飞书机器人；lark-cli 以它行事', en: 'The Feishu bot; lark-cli acts as it' },
      },
      {
        key: 'DSH_SUPERAGENT_FEISHU_CHAT',
        description: {
          zh: '接下工单的飞书群 chat_id；工单不是从飞书来的时为空',
          en: 'chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu',
        },
      },
    ],
    values: ({ deployment, trigger }) => ({
      DSH_SUPERAGENT_FEISHU_BOT: deployment.feishu ? deployment.feishu.name || deployment.feishu.botId : '',
      DSH_SUPERAGENT_FEISHU_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
    }),
  },
  facts: (deployment): Record<string, Localized | string> =>
    deployment?.feishu
      ? {
          cli: {
            zh: `当前机器人 ${deployment.feishu.name || deployment.feishu.botId}`,
            en: `Current bot ${deployment.feishu.name || deployment.feishu.botId}`,
          },
        }
      : {},
}
/** Returns the Feishu Source's settings, falling back to schema defaults while the Feishu plugin is disabled. */
export const feishuSettings = (sources: SourceRegistry): FeishuConfig =>
  sources.instance<FeishuConfig>(SOURCE)?.config ?? FeishuConfigSchema.parse({})

/**
 * Registers the Feishu Source kind and starts its loops. The returned function stops them, waits for them to end and
 * unregisters the kind.
 */
export function startFeishu(host: SourceHost): () => Promise<void> {
  const unregister = host.sources.register(feishuKind)
  const controller = new AbortController()
  const running = runFeishu(sourceContext(host, feishuKind), controller.signal)
  return async () => {
    controller.abort()
    await running
    unregister()
  }
}
