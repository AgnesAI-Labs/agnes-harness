/**
 * The Feishu part of the running service: the Feishu Source over the grant's channels, started with the other Sources,
 * and the worker tool `orchestrator_feishu_read`, which reads messages of its own ticket's chats by id or a topic of its
 * own ticket, and nothing else.
 */
import type { BundledAppGrant } from '@agnes/extension-api'
import { z } from 'zod'
import type { Store } from '../app/store.js'
import type { Ticket } from '../core/index.js'
import { feishuIo, registerFeishu } from '../sources/feishu.js'
import { listInstances } from '../sources/feishu-instances.js'
import { type FeishuIo, feishuLink } from '../sources/feishu-io.js'
import { feishuView, fetchFeishu, readTopic } from '../sources/feishu-read.js'
import { SOURCE } from '../sources/feishu-trigger.js'
import type { SuperagentApp } from './app.js'
import { asSdkClient } from './sdk.js'
import type { Tool } from './tool.js'

export const FEISHU_READ_NAME = 'orchestrator_feishu_read'
export const FEISHU_READ_DESCRIPTION =
  "Read Feishu messages of this ticket's chats by message id, or a topic of this ticket by its thread id, as the dsh-superagent-feishu skill describes. Other chats and topics are refused."
export const FeishuReadSchema = z
  .object({
    chat_id: z
      .string()
      .regex(/^oc_[A-Za-z0-9]+$/)
      .describe("The chat, one of this ticket's chats."),
    message_ids: z
      .array(z.string().regex(/^om_[A-Za-z0-9_-]+$/))
      .min(1)
      .max(20)
      .optional()
      .describe('Messages of the chat to read by id; give this or thread_id.'),
    thread_id: z
      .string()
      .regex(/^omt?_[A-Za-z0-9_-]+$/)
      .optional()
      .describe(
        "A topic of this ticket, by its thread id or its first message's id; give this or message_ids.",
      ),
    limit: z.number().int().min(1).max(50).default(20).describe('Topic messages to read, 50 at most.'),
    order: z
      .enum(['asc', 'desc'])
      .default('asc')
      .describe('Topic order: oldest first (asc) or newest first.'),
  })
  .strict()
export type FeishuReadInput = z.infer<typeof FeishuReadSchema>

/** What the tool reads with: the store of the ticket's Threads and Triggers, and the Source's channel reads. */
export interface FeishuReadHost {
  readonly store: Pick<Store, 'read' | 'triggers'>
  io(signal: AbortSignal): FeishuIo
}

/**
 * The chats a ticket subscribes to, each with the topics it follows there: by thread id, and by the first message's id,
 * each mapped to the id its topic is read by (the thread id where known).
 */
export function ticketChats(
  store: FeishuReadHost['store'],
  ticket: Ticket,
): Map<string, Map<string, string>> {
  const chats = new Map<string, Map<string, string>>()
  const add = (chat: string, root?: unknown, topic?: unknown) => {
    if (!chat) return
    const topics = chats.get(chat) ?? new Map<string, string>()
    const read = typeof topic === 'string' && topic ? topic : undefined
    if (read) topics.set(read, read)
    if (typeof root === 'string' && root) topics.set(root, read ?? topics.get(root) ?? root)
    chats.set(chat, topics)
  }
  for (const thread of store.read.subscribedThreads(SOURCE)) {
    if (!thread.subscriptions.includes(ticket.id)) continue
    const at = thread.ref.id.indexOf(':')
    add(thread.ref.id.slice(0, at), thread.ref.id.slice(at + 1), thread.meta.threadId)
  }
  for (const id of ticket.origin.triggerIds) {
    const trigger = store.triggers.get(id)
    if (trigger?.source !== SOURCE) continue
    add(
      String(trigger.meta.chatId ?? ''),
      trigger.meta.rootId ?? trigger.meta.messageId,
      trigger.meta.threadId,
    )
  }
  for (const channel of ticket.channels) if (channel.source === SOURCE) add(channel.address.chatId ?? '')
  return chats
}

/** The worker's `orchestrator_feishu_read` of `ticket`. */
export function feishuReadTool(host: FeishuReadHost, ticket: Ticket): Tool {
  return {
    name: FEISHU_READ_NAME,
    description: FEISHU_READ_DESCRIPTION,
    schema: FeishuReadSchema,
    execute: async (args, signal) => {
      const input = args as FeishuReadInput
      if (!input.message_ids === !input.thread_id) throw new Error('Give either message_ids or thread_id')
      const topics = ticketChats(host.store, ticket).get(input.chat_id)
      if (!topics) throw new Error(`The chat ${input.chat_id} is not one of this ticket's chats`)
      const io = host.io(signal)
      if (input.message_ids) {
        const events = await fetchFeishu(io, input.chat_id, input.message_ids)
        const found = new Set(events.map((event) => event.messageId))
        return {
          messages: events.map(feishuView),
          missing: input.message_ids.filter((id) => !found.has(id)),
        }
      }
      const thread = topics.get(input.thread_id ?? '')
      if (!thread) throw new Error(`The topic ${input.thread_id} is not one of this ticket's topics`)
      const events = await readTopic(io, input.chat_id, thread, input.limit, input.order)
      return { thread_id: thread, messages: events.map(feishuView) }
    },
  }
}

/**
 * Registers the Feishu Source on the grant's channels with the app: its kind at once, so its settings and policy sync
 * are there before the app starts, its loops with the other Sources, and the read tool for every worker.
 */
export function attachFeishu(
  context: {
    readonly app: SuperagentApp
    readonly grant: Pick<BundledAppGrant, 'channels'> & { client?: unknown }
  },
  log?: { warn(message: string): void },
) {
  const { app } = context
  const link = feishuLink(context.grant.channels, log ? (message) => log.warn(message) : undefined)
  // The owner's client lists the running channel instances, as the Channels page does.
  const owner = context.grant.client
  if (owner !== undefined)
    link.instances = () => listInstances((method, params) => asSdkClient(owner).call(method, params))
  const registered = registerFeishu(app.parts.sourceHost, link)
  app.extend({
    sources: () => {
      const controller = new AbortController()
      const running = registered.run(controller.signal)
      return [
        async () => {
          controller.abort()
          await running
        },
      ]
    },
    tools: (ticket) => [
      feishuReadTool({ store: app.parts.store, io: (signal) => feishuIo(app.parts.sources, signal) }, ticket),
    ],
  })
  return { kind: registered.kind, link, detach: registered.unregister }
}
