// Adapted from dsh-superagent (MIT)
/** Feishu bot CLI source: policy, settings and its trusted-backend lifecycle. */
import { z } from 'zod'
import type { ScopeResult } from '../core/index.js'
import { feishuLink, sendFeishu } from './feishu-channel.js'
import { listMembers } from './feishu-client.js'
import { type FeishuIo, type FeishuLink, linkIo, feishuLink as newLink } from './feishu-io.js'
import { refreshChatNames, rememberReply, runFeishu } from './feishu-loops.js'
import { feishuThreadContext } from './feishu-read.js'
import { feishuTriggerId, SOURCE } from './feishu-trigger.js'
import { type SourceContext, type SourceHost, sourceContext } from './host.js'
import type { SourceKind } from './kind.js'
import type { SourceRegistry } from './registry.js'

export {
  backfillChat,
  consumerRetry,
  pollThreads,
  refreshChatNames,
  takeIn,
  threadRef,
} from './feishu-loops.js'
export type { FeishuEvent } from './feishu-trigger.js'
export {
  channelEvent,
  feishuRef,
  feishuThreadId,
  feishuTime,
  feishuTrigger,
  feishuTriggerId,
  messageTrigger,
  SOURCE,
  withMentionNames,
} from './feishu-trigger.js'

const FeishuConfigSchema = z
  .object({
    cli: z.string().trim().max(4096).default(''),
    // Read old settings without losing chats or policy; these cannot identify a CLI bot.
    instance: z.string().optional(),
    claim: z.enum(['instance', 'groups']).optional(),
    readPageSize: z.number().int().min(1).max(50).default(20),
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
      .refine(
        (chats) => new Set(chats.map((chat) => chat.chatId)).size === chats.length,
        'Duplicate chat IDs',
      )
      .default([]),
    directMessages: z.boolean().default(true),
    otherChats: z.enum(['none', 'mentions']).default('none'),
  })
  .strict()
  .transform(({ instance: _instance, claim: _claim, ...config }) => config)
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>
/** The links of registered Feishu kinds, so the app's scoped readers find their configured bot I/O. */
const links = new WeakMap<object, FeishuLink>()
const unlinked = newLink()
/** Whether the Source listens to a message of `meta`'s chat, and observes it, under `config`. */
function feishuScope({ meta }: { meta: Record<string, unknown> }, config: FeishuConfig): ScopeResult {
  if (meta.direct === true)
    return config.directMessages
      ? { listened: true, observed: false, row: 'direct' }
      : { listened: false, reason: 'direct_messages_not_allowed' }
  const chat = config.chats.find((item) => item.chatId === meta.chatId)
  if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
  return config.otherChats === 'mentions'
    ? { listened: true, observed: false, row: 'other' }
    : { listened: false, reason: 'chat_not_allowed' }
}
/** The Feishu kind as described, without its bot CLI reads or writes. */
const described: Omit<
  SourceKind<FeishuConfig>,
  'channel' | 'threadContext' | 'policy' | 'refreshLabels' | 'refreshChoices'
> = {
  kind: SOURCE,
  title: { zh: '飞书', en: 'Feishu' },
  description: {
    zh: '通过已配置的机器人 lark-cli 包装程序接收消息、补收历史并回复。先验证机器人身份，再设置群聊、私聊和策略中的准入名单。',
    en: 'Receives, recovers history and replies through an already configured bot lark-cli wrapper. Verify its identity, then configure chats, direct messages and the Policy allowlist.',
  },
  schema: FeishuConfigSchema,
  facts: (deployment) =>
    deployment?.feishu
      ? {
          cli: `${deployment.feishu.name || deployment.feishu.botId} · ${deployment.feishu.appId} · ${deployment.feishu.botId}`,
        }
      : {},
  fields: [
    {
      key: 'cli',
      type: 'text',
      label: { zh: '机器人 CLI 路径', en: 'Bot CLI path' },
      hint: {
        zh: '填写已配置好认证的 lark-cli 包装程序绝对路径，且 strict-mode 为 bot。保存时验证并显示机器人身份；不需要安装 AGH 飞书插件。',
        en: 'Absolute path to an authenticated lark-cli wrapper with strict-mode bot. Saving validates and displays its bot identity; no AGH Feishu plugin is required.',
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
    {
      key: 'directMessages',
      type: 'switch',
      label: { zh: '接收私聊', en: 'Direct messages' },
      hint: {
        zh: '只接收策略允许的请求人发起的工作。',
        en: 'Only requesters allowed by the Policy may originate work.',
      },
    },
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
  ],
  health: ['feishu', 'history'],
  scope: feishuScope,
  // A reply goes only to a chat the Source still receives.
  find: (query) => ({ threads: [], terms: [...new Set(query.match(/om_[A-Za-z0-9_-]+/g) ?? [])] }),
  // A message's Trigger is named after the message, so the one it answers is named after its parent.
  repliesTo: (trigger) =>
    typeof trigger.meta.parentId === 'string' ? feishuTriggerId(trigger.meta.parentId) : undefined,
  environment: {
    variables: [
      {
        key: 'DSH_SUPERAGENT_FEISHU_CHAT',
        description: {
          zh: '接下工单的飞书群 chat_id；工单不是从飞书来的时为空',
          en: 'chat_id of the Feishu chat that started the ticket; empty when the ticket did not start on Feishu',
        },
      },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_FEISHU_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
    }),
  },
}
/** The Policy part of the Feishu kind, without its member sync. */
const policyDescribed: Omit<NonNullable<SourceKind['policy']>, 'sync'> = {
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
        .refine((users) => new Set(users.map((user) => user.id)).size === users.length, 'Duplicate open_ids')
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
        note: config.otherChats !== 'mentions' ? { zh: '不接收', en: 'Not received' } : mentions,
        cells: {
          listedUnaddressed: false,
          unlistedAddressed: config.otherChats === 'mentions',
          unlistedUnaddressed: false,
        },
      },
      {
        id: 'direct',
        label: { zh: '私聊', en: 'Direct messages' },
        note: !config.directMessages ? { zh: '不接收', en: 'Not received' } : { zh: '接收', en: 'Received' },
        cells: {
          listedUnaddressed: false,
          unlistedAddressed: config.directMessages,
          unlistedUnaddressed: false,
        },
      },
    ]
  },
}
export function feishuKindFor(link: FeishuLink): SourceKind<FeishuConfig> {
  const io = (signal?: AbortSignal): FeishuIo => linkIo(link, signal)
  const kind: SourceKind<FeishuConfig> = {
    ...described,
    refreshLabels: (host, signal) =>
      refreshChatNames(link.context ?? sourceContext(host, kind), link, signal),
    channel: {
      allowed: (address, config) =>
        feishuScope({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config)
          .listened,
      send: (_host, message) =>
        sendFeishu(io(), message, link.context!.state, (messageId) => {
          rememberReply(
            link.context!,
            messageId,
            replyPlace(link.context, message.channel.address.messageId ?? '').root,
          )
        }),
      link: feishuLink,
    },
    threadContext: feishuThreadContext(() => io()),
    policy: {
      ...policyDescribed,
      sync: {
        label: { zh: '立即同步', en: 'Sync now' },
        // Without a member read, the list in the settings stays as it is.
        ready: (part) => !!part.syncChat && !!link.context?.configured() && !!link.context.deployment.feishu,
        async run(host, part, signal) {
          const chat = String(part.syncChat)
          const members = await listMembers(io(signal), chat)
          // Preserve existing member order so policy version hashes stay stable; update names in place and append new members.
          const users = new Map(members.map((user) => [user.id, user.name]))
          const known = new Set(part.allowed.map((entry) => entry.id))
          const named = (id: string, name: string | undefined) => ({ id, ...(name ? { name } : {}) })
          return {
            ...part,
            allowed: [
              ...part.allowed
                .filter((entry) => users.has(entry.id))
                .map((entry) => named(entry.id, users.get(entry.id) ?? entry.name)),
              ...members.filter((user) => !known.has(user.id)).map((user) => named(user.id, user.name)),
            ],
          }
        },
      },
    },
  }
  links.set(kind, link)
  return kind
}
/** The Feishu kind's static description; replies and reads require a registered, configured bot. */
export const feishuKind: SourceKind<FeishuConfig> = feishuKindFor(unlinked)
/** Where a reply to `messageId` goes: the topic and chain root its Trigger recorded, else the message itself. */
function replyPlace(ctx: SourceContext | undefined, messageId: string) {
  const meta = ctx?.triggers.get(feishuTriggerId(messageId))?.meta
  const threadId = typeof meta?.threadId === 'string' ? meta.threadId : undefined
  return { threadId, root: typeof meta?.rootId === 'string' ? meta.rootId : messageId }
}
/** The registered Feishu kind's verified bot I/O, or why it is unavailable. */
export function feishuIo(sources: SourceRegistry, signal?: AbortSignal): FeishuIo {
  const kind = sources.kind(SOURCE)
  const link = kind ? links.get(kind) : undefined
  const config = sources.instance<FeishuConfig>(SOURCE)
  if (!link || link === unlinked || !config?.enabled) throw new Error('The Feishu Source is off')
  return linkIo(link, signal)
}
/** Returns the Feishu Source's settings, falling back to schema defaults when it is absent. */
export const feishuSettings = (sources: SourceRegistry): FeishuConfig =>
  sources.instance<FeishuConfig>(SOURCE)?.config ?? FeishuConfigSchema.parse({})

/**
 * Registers the Feishu kind with `link` and gives the link the kind's context; `run` runs the Source's loops until the
 * signal aborts. `unregister` removes the kind.
 */
export function registerFeishu(host: SourceHost, link: FeishuLink) {
  const kind = feishuKindFor(link)
  const unregister = host.sources.register(kind)
  const context = sourceContext(host, kind)
  link.context = context
  return {
    kind,
    context,
    unregister,
    run: (signal: AbortSignal) => runFeishu(context, link, signal),
  }
}
