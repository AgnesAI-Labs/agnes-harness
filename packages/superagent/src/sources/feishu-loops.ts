// Adapted from dsh-superagent (MIT)
/** Bot CLI event intake, bounded history recovery, chat labels and subscribed-topic recovery. */
import { consumeFeishu } from '../app/feishu-stream.js'
import { type ReceiveResult, type Thread, type Trigger, threadKey } from '../core/index.js'
import { botIdentity, resolveFeishuBot } from '../feishu-setup.js'
import { FeishuNotDispatched } from '../infra/commands.js'
import { KV } from '../kv.js'
import { SetupError } from '../setup.js'
import type { FeishuConfig } from './feishu.js'
import { feishuChatLink } from './feishu-channel.js'
import {
  type CliMessage,
  historyPages,
  listChats,
  liveMessage,
  nextPage,
  resolveTopic,
  topicPage,
} from './feishu-client.js'
import { type FeishuLink, linkIo } from './feishu-io.js'
import { type FeishuRef, readTopic } from './feishu-read.js'
import { feishuRef, feishuTriggerId, messageTrigger, SOURCE } from './feishu-trigger.js'
import { type Health, health, type SourceContext } from './host.js'
import { cursorAt, POLL_HORIZON_MS, pause, pollThreads as pollEach } from './poll.js'

const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
const scopeKey = (ctx: SourceContext, id: string) => `${botIdentity(ctx.deployment.feishu!)}:${id}`
export function report(ctx: SourceContext, link: FeishuLink, entry: string, value: Health): void {
  ctx.report(entry, value)
  const line = value.detail || value.state
  if (link.logged.get(entry) === line) return
  link.logged.set(entry, line)
  link.log?.(`Superagent Feishu Source ${entry} (${value.state}): ${line}`)
  ctx.state.set(KV.feishu.health, {
    ...ctx.state.get(KV.feishu.health),
    [entry]: {
      state: value.state,
      detail: line,
      ...(value.code ? { code: value.code } : {}),
      at: new Date().toISOString(),
    },
  })
}
const REMEMBERED = 2000
export function rememberReply(ctx: SourceContext, messageId: string, root: string): void {
  const entries = Object.entries(ctx.state.get(KV.feishu.sent) ?? {}).filter(([key]) => key !== messageId)
  ctx.state.set(KV.feishu.sent, Object.fromEntries([...entries, [messageId, root]].slice(-REMEMBERED)))
}
async function rootOf(ctx: SourceContext, link: FeishuLink, event: CliMessage): Promise<string> {
  if (event.rootId) return event.rootId
  const quoted = event.quotedMessageId
  const prior = quoted ? ctx.triggers.get(feishuTriggerId(quoted)) : undefined
  const known = prior
    ? String(prior.meta.rootId ?? prior.meta.messageId)
    : quoted
      ? ctx.state.get(KV.feishu.sent)?.[quoted]
      : undefined
  if (!event.chat.threadId) return known ?? quoted ?? event.messageId
  const key = scopeKey(ctx, event.chat.threadId)
  const recorded = ctx.state.get(KV.feishu.roots)?.[key]
  if (recorded) return recorded
  const first = known ? undefined : (await readTopic(linkIo(link), event.chat.id, event.chat.threadId, 1))[0]
  const root = known ?? first?.messageId
  if (!root) throw new Error('Feishu topic has no readable root')
  const entries = Object.entries(ctx.state.get(KV.feishu.roots) ?? {}).filter(([id]) => id !== key)
  ctx.state.set(KV.feishu.roots, Object.fromEntries([...entries, [key, root]].slice(-REMEMBERED)))
  return root
}
export type TakenIn = ReceiveResult | 'own' | 'ignored'
/** Dedupes by the existing message-derived Trigger id. Never continues a thread owned by another/unverified bot. */
export async function takeIn(ctx: SourceContext, link: FeishuLink, event: CliMessage): Promise<TakenIn> {
  if (!enabled(ctx) || event.deleted) return 'ignored'
  const io = linkIo(link)
  const identity = botIdentity(io.bot)
  if ([io.bot.botId, io.bot.appId].includes(event.sender.userId)) return 'own'
  if (ctx.triggers.get(feishuTriggerId(event.messageId))) return 'duplicate'
  const root = await rootOf(ctx, link, event)
  io.assertCurrent()
  const trigger = messageTrigger(event, root, io.bot.botId)!
  if (!trigger) return 'own'
  const existing = ctx.threads.get(threadKey(trigger.threads[0]!))
  const previous = existing && ctx.triggers.latest(existing.key)
  if (existing && previous?.meta.botIdentity !== identity) return 'ignored'
  trigger.meta.botIdentity = identity
  trigger.channel!.address.botIdentity = identity
  // Known DM chats are recovered on reconnect too; a bot cannot enumerate DM chats.
  const chatsKey = KV.feishu.botChats(identity)
  const chats = { ...ctx.state.get(chatsKey), [event.chat.id]: event.chat.type === 'dm' }
  ctx.state.set(chatsKey, chats)
  const history = KV.feishu.history(scopeKey(ctx, event.chat.id))
  if (!ctx.state.get(history)) ctx.state.set(history, cursorAt(event.at))
  return receive(ctx, trigger)
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<ReceiveResult> {
  const result = await ctx.receive(trigger)
  if (result === 'duplicate') return result
  const chatId = String(trigger.meta.chatId ?? '')
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  for (const ref of trigger.threads)
    ctx.threads.describe(threadKey(ref), {
      url: feishuChatLink(ctx.deployment.feishu!.brand, chatId),
      facts: { chat: { value: name } },
    })
  return result
}
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

/** Each run owns its abort signal. Any source change ends consumer, reads and recovery before another run starts. */
export async function runFeishu(ctx: SourceContext, link: FeishuLink, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    report(ctx, link, 'feishu', health('paused', 'setupPending'))
    return
  }
  let retry: number | undefined
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (
      !ctx.configured() ||
      !config ||
      !config.cli ||
      !ctx.deployment.feishu ||
      ctx.deployment.feishu.cli !== config.cli
    ) {
      report(
        ctx,
        link,
        'feishu',
        !config
          ? health('paused', 'sourceOff')
          : {
              state: 'paused',
              detail: ctx.problem?.detail ?? 'Enter and save a verified bot CLI path in the Feishu Source',
            },
      )
      await pause(250, signal)
      continue
    }
    const running = new AbortController()
    const active = AbortSignal.any([running.signal, signal])
    link.signal = active
    const snapshot = JSON.stringify(config)
    const bot = ctx.deployment.feishu
    const identity = botIdentity(bot)
    // Seed cursors before connecting so the first disconnect also has a recovery window.
    for (const { chatId } of config.chats) {
      const key = KV.feishu.history(scopeKey(ctx, chatId))
      if (!ctx.state.get(key)) ctx.state.set(key, new Date().toISOString())
    }
    const changed = () =>
      !ctx.configured() ||
      JSON.stringify(enabled(ctx)) !== snapshot ||
      !ctx.deployment.feishu ||
      botIdentity(ctx.deployment.feishu) !== identity
    const check = setInterval(() => {
      if (changed()) running.abort()
    }, 250)
    const began = Date.now()
    const background: Promise<void>[] = []
    try {
      const commands = ctx.commands.withSignal(active)
      const verified = await resolveFeishuBot(ctx.deployment, config, (argv) =>
        commands.run(argv[0]!, argv.slice(1)),
      )
      if (botIdentity(verified) !== identity)
        throw new FeishuNotDispatched(
          'Feishu wrapper now names a different bot; save its settings to validate the change',
        )
      if (changed()) continue
      await consumeFeishu({
        cli: bot.cli,
        signal: active,
        ready(streamSignal) {
          link.signal = streamSignal
          link.listening = true
          report(ctx, link, 'feishu', {
            state: 'ready',
            detail: `Listening as ${bot.name || bot.botId} (${bot.appId})`,
            at: new Date().toISOString(),
          })
          background.push(recoveryLoop(ctx, link, config, streamSignal), namesLoop(ctx, link, streamSignal))
        },
        warning() {
          report(ctx, link, 'feishu', {
            state: 'error',
            detail: 'Feishu consumer reported dropped events or a warning; history recovery is active',
          })
        },
        async receive(value) {
          if (changed() || active.aborted) return
          await takeIn(ctx, link, liveMessage(value, { bot }))
        },
      })
    } catch (error) {
      if (!active.aborted)
        report(ctx, link, 'feishu', {
          state: 'error',
          detail:
            error instanceof SetupError
              ? error.problem.detail
              : error instanceof FeishuNotDispatched
                ? error.message
                : 'Feishu event consumer stopped or failed; reconnecting with history recovery',
        })
    } finally {
      running.abort()
      clearInterval(check)
      link.listening = false
      await Promise.allSettled(background)
    }
    if (changed()) {
      retry = undefined
      continue
    }
    retry = consumerRetry(retry, Date.now() - began)
    await pause(retry, signal)
  }
}
export async function refreshChatNames(
  ctx: SourceContext,
  link: FeishuLink,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const names = await listChats(linkIo(link, signal))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
async function namesLoop(ctx: SourceContext, link: FeishuLink, signal: AbortSignal) {
  while (!signal.aborted) {
    await refreshChatNames(ctx, link, signal).catch(() => {})
    await pause(60_000, signal)
  }
}
async function recoveryLoop(ctx: SourceContext, link: FeishuLink, config: FeishuConfig, signal: AbortSignal) {
  while (!signal.aborted) {
    await recoverRound(ctx, link, config, signal).catch(() => {
      if (!signal.aborted)
        report(ctx, link, 'history', {
          state: 'error',
          detail: 'Feishu recovery failed; retrying without advancing its cursor',
        })
    })
    await pause(60_000, signal)
  }
}
export async function recoverRound(
  ctx: SourceContext,
  link: FeishuLink,
  config: FeishuConfig,
  signal: AbortSignal,
): Promise<void> {
  const errors: string[] = []
  const known = ctx.state.get(KV.feishu.botChats(botIdentity(ctx.deployment.feishu!))) ?? {}
  const chats = new Map(config.chats.map((c) => [c.chatId, false]))
  for (const [id, direct] of Object.entries(known))
    if (direct ? config.directMessages : config.otherChats === 'mentions') chats.set(id, direct)
  for (const [chatId, direct] of chats) {
    if (signal.aborted) return
    const started = new Date().toISOString()
    const key = KV.feishu.history(scopeKey(ctx, chatId))
    const since = ctx.state.get(key)
    if (!since) {
      ctx.state.set(key, started)
      continue
    }
    try {
      const result = await backfillChat(
        ctx,
        link,
        chatId,
        since,
        started,
        signal,
        (at) => ctx.state.set(key, at),
        direct,
      )
      if (!signal.aborted && !result.behind) ctx.state.set(key, cursorAt(started))
    } catch {
      if (!signal.aborted) errors.push(chatId)
    }
  }
  await pollThreads(ctx, link, signal).catch(() => {
    errors.push('subscribed topics')
  })
  if (!signal.aborted)
    report(ctx, link, 'history', {
      state: errors.length ? 'error' : 'ready',
      detail: errors.length
        ? `History recovery pending for ${errors.join(', ')}`
        : 'Configured chats and known direct chats recovered',
      at: new Date().toISOString(),
    })
}
export const HISTORY_SLICE_MS = 3_600_000
export const HISTORY_OVERLAP_MS = 1000
export const HISTORY_SLICES_PER_ROUND = 24
export interface Recovery {
  behind?: string
}
export async function backfillChat(
  ctx: SourceContext,
  link: FeishuLink,
  chatId: string,
  since: string,
  until: string,
  signal: AbortSignal,
  advance: (at: string) => void = () => {},
  direct = false,
): Promise<Recovery> {
  const io = linkIo(link, signal)
  const end = Date.parse(until)
  let from = Date.parse(since)
  const topicsKey = KV.feishu.topics(scopeKey(ctx, chatId))
  const topics = { ...ctx.state.get(topicsKey) }
  for (let slices = 0; from < end && slices < HISTORY_SLICES_PER_ROUND; slices++) {
    const to = Math.min(from + HISTORY_SLICE_MS, end)
    for await (const events of historyPages(
      io,
      chatId,
      from,
      Math.min(to + HISTORY_OVERLAP_MS, end),
      direct,
    )) {
      for (const event of events) {
        io.assertCurrent()
        await takeIn(ctx, link, event)
        if (event.chat.threadId) topics[event.chat.threadId] = event.at
      }
    }
    // Retain the original cursor until topic reads also complete; their replies are not all in chat history.
    from = to
  }
  for (const [topic, at] of Object.entries(topics)) {
    if (end - Date.parse(at) >= POLL_HORIZON_MS) {
      delete topics[topic]
      continue
    }
    await recoverTopic(ctx, link, chatId, topic, Date.parse(since), signal)
  }
  ctx.state.set(topicsKey, topics)
  if (from < end) advance(new Date(from).toISOString())
  return from < end ? { behind: new Date(from).toISOString() } : {}
}
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const trigger = ctx.triggers.latest(thread.key)
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  const ref = trigger ? feishuRef(trigger) : undefined
  return meta.chatId && meta.messageId && meta.sourceTriggerId
    ? { ...ref, triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
    : ref
}
export async function pollThreads(ctx: SourceContext, link: FeishuLink, signal?: AbortSignal): Promise<void> {
  await pollEach(
    ctx,
    SOURCE,
    () => !!signal?.aborted,
    async (thread) => {
      const trigger = ctx.triggers.latest(thread.key)
      if (trigger?.meta.botIdentity !== botIdentity(ctx.deployment.feishu!)) return
      const ref = threadRef(ctx, thread)
      if (!ref || !enabled(ctx)) return
      const topic =
        String(thread.meta.threadId ?? ref.threadId ?? '') ||
        (await resolveTopic(linkIo(link, signal), ref.chatId, ref.rootId ?? ref.messageId))
      if (!topic) return
      await recoverTopic(ctx, link, ref.chatId, topic, Date.parse(thread.createdAt), signal)
      ctx.threads.patch(thread.key, { threadId: topic })
    },
  )
}
async function recoverTopic(
  ctx: SourceContext,
  link: FeishuLink,
  chatId: string,
  topic: string,
  since: number,
  signal?: AbortSignal,
) {
  const io = linkIo(link, signal),
    pages = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await topicPage(io, chatId, topic, 50, 'desc', cursor)
    for (const event of [...page.messages].reverse()) {
      io.assertCurrent()
      const direct = ctx.state.get(KV.feishu.botChats(botIdentity(io.bot)))?.[chatId] === true
      if (direct) event.chat.type = 'dm'
      if (Date.parse(event.at) >= since) await takeIn(ctx, link, event)
    }
    if (page.messages.some((event) => Date.parse(event.at) < since)) break
    cursor = nextPage(page, pages)
  } while (cursor)
}
