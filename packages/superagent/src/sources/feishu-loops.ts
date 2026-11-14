// Adapted from dsh-superagent (MIT)
/** Feishu background loops: live event stream consumer, chat/topic history backfill, chat name refresh, and subscribed thread polling. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { type Thread, type Trigger, threadKey } from '../core/index.js'
import type { FeishuBot } from '../deployment.js'
import { type Tally, validItems } from '../infra/commands.js'
import { KV } from '../kv.js'
import type { FeishuConfig } from './feishu.js'
import { feishuChatLink } from './feishu-channel.js'
import { type FeishuRef, readFeishu } from './feishu-read.js'
import {
  feishuRef,
  feishuTime,
  feishuTrigger,
  HistoricalMessageSchema,
  HistoryPageSchema,
  historyEvent,
  SOURCE,
  topicEvent,
} from './feishu-trigger.js'
import { health, type SourceContext } from './host.js'
import { cursorAt, POLL_HORIZON_MS, pollThreads as pollEach, polled } from './poll.js'

export const runFeishu = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch, backfillLoop, chatNamesLoop].map((loop) => loop(ctx, signal)))
const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu Source has no working bot CLI')
  return resolved
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<void> {
  await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId) return
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  const chat =
    trigger.meta.direct === true ? { value: { zh: '私聊', en: 'Direct message' } } : { value: name }
  for (const ref of trigger.threads)
    ctx.threads.describe(threadKey(ref), { url: chatLink(ctx, chatId), facts: { chat } })
}
const chatLink = (ctx: SourceContext, chatId: string): string =>
  feishuChatLink(ctx.deployment.feishu?.brand ?? 'feishu', chatId)
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report('feishu', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}

/** Runs the live event consumer only while the Source is enabled; disabling it stops the consumer within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing runs.
  if (!available(ctx)) return
  let retry: number | undefined
  while (!signal.aborted) {
    if (!enabled(ctx)) {
      ctx.report('feishu', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => {
      if (!enabled(ctx)) running.abort()
    }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try {
      await consume(ctx, running.signal)
    } catch (error) {
      if (!running.signal.aborted) ctx.report('feishu', { state: 'error', detail: String(error) })
    } finally {
      clearInterval(check)
      signal.removeEventListener('abort', stop)
    }
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
async function consume(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const child = spawn(bot(ctx).cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
  })
  const stdout = createInterface({ input: child.stdout })
  const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve()
  let diagnostic = ''
  let ready = false
  const stop = (): void => {
    child.stdin.end()
    child.kill('SIGTERM')
  }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => {
    diagnostic = 'Feishu event consumer did not become ready within 45 seconds'
    stop()
  }, 45_000)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith('[event] ready')) {
      ready = true
      clearTimeout(timeout)
      ctx.report('feishu', {
        state: 'ready',
        detail: 'Listening for bot events',
        at: new Date().toISOString(),
      })
    } else if (/WARN|drop|error/.test(line)) ctx.report('feishu', { state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    chain = chain
      .then(async () => {
        if (line.length > 1_048_576) throw new Error('Feishu event exceeds 1 MiB')
        const trigger = feishuTrigger(JSON.parse(line), bot(ctx).botId, bot(ctx).appId)
        // Events already read when the Source is disabled are dropped; the consumer stops shortly after.
        if (!trigger || !enabled(ctx)) return
        const chats = ctx.state.get(KV.feishu.chats) ?? {}
        chats[String(trigger.meta.chatId)] = trigger.meta.direct === true
        ctx.state.set(KV.feishu.chats, chats)
        await receive(ctx, trigger)
      })
      .catch((error) => {
        ctx.report('feishu', { state: 'error', detail: String(error) })
      })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) =>
        new Error(`Feishu event consumer exited (${code}, ready=${ready}): ${diagnostic}`)
      child.once('close', (code) => (signal.aborted ? resolve() : reject(exited(code))))
    })
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', stop)
    stdout.close()
    stderr.close()
    await chain
  }
}

/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
export async function refreshChatNames(
  ctx: SourceContext,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const commands = ctx.commands.withSignal(signal)
  const result = z
    .looseObject({
      chats: z.array(z.looseObject({ chat_id: z.string(), name: z.string().nullish() })).optional(),
    })
    .parse(await commands.lark(['im', '+chat-list', '--page-all', '--page-size', '100']))
  const names = Object.fromEntries(
    (result.chats ?? []).filter((chat) => chat.name).map((chat) => [chat.chat_id, chat.name!]),
  )
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads the chat list every minute independently of history backfill (whose rounds can take much longer), so newly joined chats appear within a minute. */
async function chatNamesLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) return
  while (!signal.aborted) {
    if (enabled(ctx)) {
      try {
        await refreshChatNames(ctx, signal)
      } catch {
        /* Names are a display aid; the stored list stays until a later read succeeds. */
      }
    }
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
async function backfillLoop(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!available(ctx)) {
    ctx.report('history', health('paused', 'feishuBotMissing'))
    return
  }
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('history', health('paused', 'sourceOff'))
      await delay(60_000, undefined, { signal }).catch(() => {})
      continue
    }
    const seen = ctx.state.get(KV.feishu.chats) ?? {}
    const known = Object.entries(seen).filter(([, direct]) => direct && config.directMessages)
    const chats = {
      ...Object.fromEntries(config.chats.map((chat) => [chat.chatId, false])),
      ...Object.fromEntries(known),
    }
    const errors: string[] = []
    const tally = { skipped: 0 }
    for (const [chatId, direct] of Object.entries(chats)) {
      if (signal.aborted) break
      const started = new Date().toISOString()
      const cursorKey = KV.feishu.history(chatId)
      const since = ctx.state.get(cursorKey)
      if (since === undefined) {
        ctx.state.set(cursorKey, started)
        continue
      }
      try {
        await backfillChat(ctx, chatId, direct, since, started, signal, tally)
        if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
      } catch (error) {
        if (!signal.aborted) errors.push(`${chatId}: ${String(error)}`)
      }
    }
    await pollThreads(ctx, signal, tally)
    const skipped = tally.skipped ? `; ${tally.skipped} unreadable messages skipped` : ''
    if (!signal.aborted)
      ctx.report(
        'history',
        errors.length
          ? { state: 'error', detail: errors.join('\n') }
          : {
              state: 'ready',
              detail: `Configured groups and known direct chats recovered${skipped}`,
              at: new Date().toISOString(),
            },
      )
    await delay(60_000, undefined, { signal }).catch(() => {})
  }
}
/**
 * Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
 * Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
 */
export async function backfillChat(
  ctx: SourceContext,
  chatId: string,
  direct: boolean,
  since: string,
  until: string,
  signal: AbortSignal,
  tally: Tally = { skipped: 0 },
): Promise<void> {
  const commands = ctx.commands.withSignal(signal)
  const topicsKey = KV.feishu.topics(chatId)
  const topics = { ...ctx.state.get(topicsKey) }
  const scan = async (kind: 'chat' | 'thread', id: string): Promise<void> => {
    let page: string | undefined
    const pages = new Set<string>()
    do {
      if (signal.aborted) throw signal.reason
      const seconds = (time: string) => String(Math.floor(Date.parse(time) / 1000))
      const parameters = {
        container_id_type: kind,
        container_id: id,
        start_time: seconds(since),
        end_time: seconds(until),
        sort_type: 'ByCreateTimeAsc',
        page_size: 50,
        ...(page ? { page_token: page } : {}),
      }
      const request = ['api', 'GET', '/open-apis/im/v1/messages', '--params', JSON.stringify(parameters)]
      const result = HistoryPageSchema.parse(await commands.lark(request))
      for (const message of validItems(HistoricalMessageSchema, result.items, tally)) {
        const outside = message.chat_id !== chatId || (kind === 'thread' && message.thread_id !== id)
        if (outside) throw new Error('Feishu history returned a message outside the requested chat or thread')
        if (message.deleted) continue
        const at = feishuTime(message.create_time)
        if (message.thread_id && !(Date.parse(topics[message.thread_id] ?? '') >= Date.parse(at)))
          topics[message.thread_id] = at
        const trigger = feishuTrigger(historyEvent(message, chatId, direct), bot(ctx).botId, bot(ctx).appId)
        if (trigger) await receive(ctx, trigger)
      }
      const stuck = result.has_more && (!result.page_token || pages.has(result.page_token))
      if (stuck) throw new Error('Feishu history pagination did not advance')
      page = result.has_more ? result.page_token : undefined
      if (page) pages.add(page)
    } while (page)
  }
  await scan('chat', chatId)
  // A quiet topic is forgotten unless a subscribed Thread that is still polled follows it.
  const followed = new Set(
    ctx.threads
      .subscribed(SOURCE)
      .filter((thread) => polled(ctx, thread))
      .map((thread) => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? '')),
  )
  for (const [id, seen] of Object.entries(topics)) {
    if (!followed.has(id) && Date.parse(until) - Date.parse(seen) >= POLL_HORIZON_MS) delete topics[id]
  }
  ctx.state.set(topicsKey, topics)
  for (const id of Object.keys(topics)) await scan('thread', id)
  ctx.state.set(topicsKey, topics)
}

/** Resolves the retained source message reference for polling a subscribed thread. */
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  if (meta.chatId && meta.messageId && meta.sourceTriggerId) {
    return { triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
  }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? feishuRef(trigger) : undefined
}
/** Polls subscribed Feishu threads within the polling horizon so replies missed by the live stream become triggers. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally): Promise<void> {
  await pollEach(
    ctx,
    SOURCE,
    () => !!signal?.aborted,
    (thread) => pollThread(ctx, thread, signal, tally),
  )
}
async function pollThread(
  ctx: SourceContext,
  thread: Thread,
  signal?: AbortSignal,
  tally?: Tally,
): Promise<void> {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  // The Source was turned off; the next round polls again.
  if (!config) return
  const commands = ctx.commands.withSignal(signal)
  const pageSize = config.readPageSize
  const checkpoint = KV.feishu.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.feishu.initialized(thread.key))
  if (!initialized) {
    // Mark root and parent messages as seen on first poll so historical context is not ingested as new triggers.
    for (const section of ['root', 'parent']) {
      const result = await readFeishu(commands, ref, `feishu/${ref.triggerId}/${section}`, pageSize)
      if ('message' in result && result.message) known.add(result.message.message_id)
    }
    ctx.state.set(checkpoint, [...known])
  }
  const direct = ctx.state.get(KV.feishu.chats)?.[ref.chatId] === true
  const since = Date.parse(thread.createdAt)
  const root = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
  let resource: string | null = `feishu/${ref.triggerId}/thread`
  while (resource) {
    if (signal?.aborted) return
    const result = await readFeishu(commands, ref, resource, pageSize, 'desc')
    if (!('messages' in result)) throw new Error('Expected Feishu thread messages')
    if (tally && 'skipped' in result) tally.skipped += result.skipped ?? 0
    if ('thread_id' in result && result.thread_id && thread.meta.threadId !== result.thread_id) {
      ctx.threads.patch(thread.key, { threadId: result.thread_id })
    }
    const encounteredKnown = result.messages.some((message) => known.has(message.message_id))
    const { botId, appId } = bot(ctx)
    for (const message of result.messages
      .filter((item) => !known.has(item.message_id) && !item.deleted)
      .reverse()) {
      if (signal?.aborted) return
      const trigger = feishuTrigger(topicEvent(message, ref.chatId, direct, root), botId, appId)
      // Ignore messages older than the thread subscription on initial poll.
      if (!trigger || (!initialized && Date.parse(trigger.at) < since)) continue
      await receive(ctx, trigger)
    }
    for (const message of result.messages) known.add(message.message_id)
    ctx.state.set(checkpoint, [...known])
    if (initialized && encounteredKnown) break
    resource = result.next_resource
  }
  ctx.state.set(KV.feishu.initialized(thread.key), true)
}
