// Adapted from dsh-superagent (MIT)
/**
 * Feishu background loops over the AGH channel: the subscription to the listed chats (retried while the channel
 * refuses it), chat and topic history recovery, chat name refresh and subscribed topic polling.
 */
import type { ChannelEvent, MessageEvent } from '@agnes/extension-api/channel-contract'
import type { ReceiveResult, Thread, Trigger } from '../core/index.js'
import { threadKey } from '../core/index.js'
import { type Key, KV } from '../kv.js'
import type { FeishuConfig } from './feishu.js'
import { feishuChatLink } from './feishu-channel.js'
import {
  channelCode,
  channelRead,
  errorText,
  type FeishuLink,
  instanceRef,
  linkIo,
  probeFeatures,
} from './feishu-io.js'
import { type FeishuRef, readHistory, readTopic } from './feishu-read.js'
import { feishuRef, feishuTriggerId, messageTrigger, SOURCE } from './feishu-trigger.js'
import { type Health, health, type SourceContext } from './host.js'
import { cursorAt, POLL_HORIZON_MS, pause, pollThreads as pollEach, polled } from './poll.js'

/** Runs the Source's loops until `signal` aborts. */
export function runFeishu(ctx: SourceContext, link: FeishuLink, signal: AbortSignal): Promise<unknown> {
  const wake = new Wake()
  return Promise.allSettled([
    watch(ctx, link, signal, wake),
    backfillLoop(ctx, link, signal, wake),
    chatNamesLoop(ctx, link, signal),
  ])
}
const enabled = (ctx: SourceContext): FeishuConfig | undefined => ctx.config<FeishuConfig>(SOURCE)
/** The channel instance id the Source's settings name. */
export const channelOf = (config: FeishuConfig | undefined): string =>
  instanceRef(config?.instance ?? '').instanceId
const ioOf = (ctx: SourceContext, link: FeishuLink, signal?: AbortSignal) =>
  linkIo(link, channelOf(enabled(ctx)), signal)

/** Reports one health entry and logs it when its text changed. */
export function report(ctx: SourceContext, link: FeishuLink, entry: string, value: Health): void {
  ctx.report(entry, value)
  if (value.state === 'starting') return
  const line = value.detail || value.state
  if (link.logged.get(entry) === line) return
  link.logged.set(entry, line)
  link.log?.(`Superagent Feishu Source ${entry} (${value.state}): ${line}`)
  // Kept with the Source's records, so a check outside this run reads what it lacks or why it waits.
  const kept = {
    state: value.state,
    detail: line,
    ...(value.code ? { code: value.code } : {}),
    at: new Date().toISOString(),
  }
  ctx.state.set(KV.feishu.health, { ...ctx.state.get(KV.feishu.health), [entry]: kept })
}

/** Lets a round that waits for its next turn start at once. */
class Wake {
  private wakers = new Set<() => void>()
  wake(): void {
    for (const waker of [...this.wakers]) waker()
  }
  async wait(ms: number, signal: AbortSignal): Promise<void> {
    const woken = new AbortController()
    const waker = () => woken.abort()
    this.wakers.add(waker)
    try {
      await pause(ms, AbortSignal.any([signal, woken.signal]))
    } finally {
      this.wakers.delete(waker)
    }
  }
}

const REMEMBERED = 2000
/** Sets `name` in a bounded map record, dropping its oldest entries past the bound. */
function remember(
  ctx: SourceContext,
  record: Key<Record<string, string>>,
  name: string,
  value: string,
): void {
  const entries = Object.entries(ctx.state.get(record) ?? {}).filter(([key]) => key !== name)
  entries.push([name, value])
  ctx.state.set(record, Object.fromEntries(entries.slice(-REMEMBERED)))
}
const flightKey = (chatId: string, messageId: string) => `${chatId}\0${messageId}`
/** Marks a reply to `messageId` as being sent until the returned function runs. */
export function inFlight(link: FeishuLink, chatId: string, messageId: string, root: string): () => void {
  const key = flightKey(chatId, messageId)
  const current = link.sending.get(key)
  link.sending.set(key, { root, count: (current?.count ?? 0) + 1 })
  return () => {
    const now = link.sending.get(key)
    if (!now || now.count <= 1) link.sending.delete(key)
    else link.sending.set(key, { ...now, count: now.count - 1 })
  }
}
/**
 * Records a reply the bot sent: its id with the root of the chain it answers, and, when it came back before the send
 * returned and was taken in, the bot's own id from it.
 */
export function rememberReply(ctx: SourceContext, messageId: string, root: string): void {
  rememberSent(ctx, messageId, root)
  const echoed = ctx.triggers.get(feishuTriggerId(messageId))
  if (echoed) ctx.state.set(KV.feishu.self, echoed.actor.id)
}
/** Records a message the bot sent and the root of the chain it answers. */
export const rememberSent = (ctx: SourceContext, messageId: string, root: string): void =>
  remember(ctx, KV.feishu.sent, messageId, root)
/** The root of the chain a known message belongs to: a message that came in, or one the bot sent. */
function knownRoot(ctx: SourceContext, messageId: string): string | undefined {
  const trigger = ctx.triggers.get(feishuTriggerId(messageId))
  if (trigger) return String(trigger.meta.rootId ?? trigger.meta.messageId ?? messageId)
  return ctx.state.get(KV.feishu.sent)?.[messageId]
}
/**
 * The root a message's Thread is named after. A message in a topic belongs to the topic's first message: as recorded,
 * as the message it quotes belongs to, or as the topic reads; failing all, the topic id stands for it. A message outside
 * a topic that quotes a known message joins that message's chain, so a quote of a ticket's message or of the bot's
 * reply reaches the ticket; one that quotes an unknown message starts a chain at it; any other starts its own.
 */
async function rootOf(ctx: SourceContext, link: FeishuLink, event: MessageEvent): Promise<string> {
  const topic = event.chat.threadId
  const quoted = event.quotedMessageId
  const known = quoted ? knownRoot(ctx, quoted) : undefined
  if (!topic) return known ?? quoted ?? event.messageId
  const recorded = ctx.state.get(KV.feishu.roots)?.[topic]
  if (recorded) return recorded
  let root = known
  if (!root && !link.missing.has('threads')) {
    const first = await readTopic(ioOf(ctx, link), event.chat.id, topic, 1, 'asc').catch(() => [])
    root = first[0]?.messageId
  }
  root ??= topic
  remember(ctx, KV.feishu.roots, topic, root)
  return root
}

export type TakenIn = ReceiveResult | 'own' | 'ignored'
/**
 * Takes in one channel message, live or read back. A message already taken in (by its Feishu message id) is a
 * duplicate and changes nothing; a message the bot sent teaches the Source the bot's own id and is dropped.
 */
export async function takeIn(ctx: SourceContext, link: FeishuLink, event: MessageEvent): Promise<TakenIn> {
  if (event.kind !== 'message') return 'ignored'
  if (ctx.triggers.get(feishuTriggerId(event.messageId))) return 'duplicate'
  const answered = ctx.state.get(KV.feishu.sent)?.[event.messageId]
  if (answered !== undefined) {
    ctx.state.set(KV.feishu.self, event.sender.userId)
    if (event.chat.threadId) remember(ctx, KV.feishu.roots, event.chat.threadId, answered)
    return 'own'
  }
  const self = ctx.state.get(KV.feishu.self)
  if (ctx.state.get(KV.feishu.echoes)?.[event.messageId] !== undefined) return 'own'
  // A bot message that answers a message the bot is replying to now is a part of that reply, unless the bot is known
  // and it is someone else. It is dropped, but teaches nothing: another bot may answer the same message meanwhile.
  const flight =
    event.sender.kind === 'bot' && event.quotedMessageId && (!self || self === event.sender.userId)
      ? link.sending.get(flightKey(event.chat.id, event.quotedMessageId))
      : undefined
  if (flight) {
    remember(ctx, KV.feishu.echoes, event.messageId, flight.root)
    return 'own'
  }
  const trigger = messageTrigger(event, await rootOf(ctx, link, event), self)
  if (!trigger) return 'own'
  return receive(ctx, trigger)
}
async function receive(ctx: SourceContext, trigger: Trigger): Promise<ReceiveResult> {
  const result = await ctx.receive(trigger)
  const chatId = String(trigger.meta.chatId ?? '')
  if (!chatId || result === 'duplicate') return result
  const name = ctx.state.get(KV.sources.labels(SOURCE))?.[chatId] ?? chatId
  for (const ref of trigger.threads)
    ctx.threads.describe(threadKey(ref), {
      url: feishuChatLink('feishu', chatId),
      facts: { chat: { value: name } },
    })
  return result
}

/** Wait before subscribing again after a refusal: one second, doubling up to a minute. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)
/** What the Source still needs before it can claim or subscribe, as a health report, or undefined when it has all. */
function setupNeeded(config: FeishuConfig): Health | undefined {
  const { pluginId, instanceId } = instanceRef(config.instance)
  if (!instanceId) return health('paused', 'feishuChannelUnset')
  if (config.claim === 'instance') return pluginId ? undefined : health('paused', 'feishuPluginUnset')
  if (config.chats.length === 0) return health('paused', 'feishuChatsUnset')
  return undefined
}
/** What the Source listens to: a change claims again. Groups are listed only while they are what it claims. */
const subscription = (config: FeishuConfig) =>
  JSON.stringify([config.instance, config.claim === 'groups' ? config.chats.map((chat) => chat.chatId) : []])
/**
 * Claims the whole instance (`claim: 'instance'`), or subscribes the listed groups of it; the returned function ends
 * the claim or the subscription.
 */
function listen(link: FeishuLink, config: FeishuConfig, onEvent: (event: ChannelEvent) => void): () => void {
  if (config.claim === 'groups')
    return link.channels.subscribe(
      channelOf(config),
      config.chats.map((chat) => chat.chatId),
      onEvent,
    )
  const claim = link.channels.claimInstance(instanceRef(config.instance), onEvent)
  return () => claim.release()
}
/** How long an instance in use may be Superagent's own previous run, which releases it within seconds. */
export const RELEASE_GRACE_MS = 10_000
/**
 * Why the instance refused the Source, as setup still required. An instance in use stays with its users; it is
 * reported as the owner's or another feature's only once it stayed in use past `RELEASE_GRACE_MS`, so a previous run
 * of Superagent that still holds it is not taken for one. `busy` tracks since when this listening was refused so.
 */
function refusal(config: FeishuConfig, error: unknown, busy: { key: string; since: number }): Health {
  const channel = channelOf(config)
  const reason = channelCode(error) ?? (error instanceof Error ? error.message : String(error))
  if (config.claim === 'groups') return health('paused', 'feishuChannelRefused', { channel, reason })
  if (reason !== 'CHANNEL_CLAIMED') return health('paused', 'feishuInstanceRefused', { channel, reason })
  const key = subscription(config)
  if (busy.key !== key) Object.assign(busy, { key, since: Date.now() })
  return Date.now() - busy.since < RELEASE_GRACE_MS
    ? health('paused', 'feishuInstanceReleasing', { channel })
    : health('paused', 'feishuInstanceShared', { channel })
}

/**
 * Keeps the instance claimed, or the listed chats subscribed, while the Source is on: a refusal (such as a channel
 * instance that is missing, not running yet or in use) is reported as setup still required and retried with backoff;
 * the claim is renewed when the instance, the claim or the chats change and ends within five seconds once the Source
 * is off.
 */
async function watch(ctx: SourceContext, link: FeishuLink, signal: AbortSignal, wake: Wake): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    report(ctx, link, 'feishu', health('paused', 'setupPending'))
    return
  }
  let retry: number | undefined
  const busy = { key: '', since: 0 }
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      waiting(ctx, link, health('paused', 'sourceOff'))
      await pause(5000, signal)
      continue
    }
    const needed = setupNeeded(config)
    if (needed) {
      waiting(ctx, link, needed)
      await pause(5000, signal)
      continue
    }
    const current = subscription(config)
    let chain: Promise<unknown> = Promise.resolve()
    let unsubscribe: () => void
    try {
      unsubscribe = listen(link, config, (event) => {
        chain = chain
          .then(async () => {
            if (event.kind === 'message' && enabled(ctx)) await takeIn(ctx, link, event)
          })
          .catch((error: unknown) =>
            report(ctx, link, 'feishu', { state: 'error', detail: errorText(error) }),
          )
      })
    } catch (error) {
      waiting(ctx, link, refusal(config, error, busy))
      retry = consumerRetry(retry, 0)
      await pause(retry, signal)
      continue
    }
    retry = undefined
    busy.key = ''
    link.listening = true
    report(ctx, link, 'feishu', {
      state: 'ready',
      detail:
        config.claim === 'instance'
          ? `Receiving every chat and direct message of ${channelOf(config)}`
          : `Listening to ${config.chats.length} chats on ${channelOf(config)}`,
      at: new Date().toISOString(),
    })
    await reportFeatures(ctx, link).catch(() => {})
    reportOthers(ctx, link, config)
    // A new subscription catches up on what the chats said meanwhile.
    wake.wake()
    while (!signal.aborted) {
      await pause(5000, signal)
      const now = enabled(ctx)
      if (!now || subscription(now) !== current) break
    }
    link.listening = false
    unsubscribe()
    await chain
  }
}
/**
 * Reports why the Source does not listen on its own entry, and on the entries of what listening brings (recovery,
 * member and message reads) that they wait for it, so the Source shows paused rather than starting.
 */
function waiting(ctx: SourceContext, link: FeishuLink, why: Health): void {
  link.listening = false
  report(ctx, link, 'feishu', why)
  const pending = why.code === 'sourceOff' ? why : health('paused', 'feishuWaiting')
  for (const entry of ['history', 'members', 'reads', 'others']) report(ctx, link, entry, pending)
}
/**
 * Says how direct messages and other chats are received. On an instance of its own the Source receives them as its
 * settings say. Claiming only the listed groups, it notes, while either is on, that they need a Feishu bot instance of
 * Superagent's own: the host routes no direct chat to a group subscriber. The note is information, not a fault.
 */
export function reportOthers(ctx: SourceContext, link: FeishuLink, config: FeishuConfig): void {
  if (config.claim === 'instance') {
    const detail =
      'Direct messages and other chats come from the instance of its own, as the settings receive them'
    report(ctx, link, 'others', { state: 'ready', detail, at: new Date().toISOString() })
    return
  }
  const wanted = config.directMessages || config.otherChats === 'mentions'
  report(
    ctx,
    link,
    'others',
    wanted
      ? { ...health('ready', 'feishuDedicatedBot'), at: new Date().toISOString() }
      : { state: 'ready', detail: 'Only the listed chats are received', at: new Date().toISOString() },
  )
}
/** Finds which reads the channel lacks and reports each missing feature on its own health entry. */
export async function reportFeatures(ctx: SourceContext, link: FeishuLink): Promise<void> {
  const missing = await probeFeatures(ioOf(ctx, link))
  const ready = (detail: string): Health => ({ state: 'ready', detail, at: new Date().toISOString() })
  if (missing.has('history')) report(ctx, link, 'history', health('paused', 'feishuNoHistory'))
  report(
    ctx,
    link,
    'members',
    missing.has('members') ? health('paused', 'feishuNoMembers') : ready('Chat members can be read'),
  )
  report(
    ctx,
    link,
    'reads',
    missing.has('messages') || missing.has('threads')
      ? health('paused', 'feishuNoReads')
      : ready('Messages and threads can be read'),
  )
}

/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
export async function refreshChatNames(
  ctx: SourceContext,
  link: FeishuLink,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const io = ioOf(ctx, link, signal)
  const chats = await channelRead(io, 'chats', (channels, channel) => channels.listChats(channel))
  const names = Object.fromEntries(chats.flatMap((chat) => (chat.name ? [[chat.id, chat.name]] : [])))
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Rereads the chat list every minute independently of history recovery, so newly joined chats appear within a minute. */
async function chatNamesLoop(ctx: SourceContext, link: FeishuLink, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) return
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (channelOf(config) && !link.missing.has('chats')) {
      try {
        await refreshChatNames(ctx, link, signal)
      } catch {
        /* Names are a display aid; the stored list stays until a later read succeeds. */
      }
    }
    await pause(60_000, signal)
  }
}

/**
 * Every minute, and at once after each new subscription: recovers each listed chat's messages since its cursor (the
 * previous round's start, five seconds early) and the recent messages of its active topics, then polls subscribed
 * topics. Without a history read nothing is recovered, which its health says; topics are still polled.
 */
async function backfillLoop(
  ctx: SourceContext,
  link: FeishuLink,
  signal: AbortSignal,
  wake: Wake,
): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) return
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      report(ctx, link, 'history', health('paused', 'sourceOff'))
      await wake.wait(60_000, signal)
      continue
    }
    if (link.listening) await recoverRound(ctx, link, config, signal)
    await wake.wait(60_000, signal)
  }
}
export async function recoverRound(
  ctx: SourceContext,
  link: FeishuLink,
  config: FeishuConfig,
  signal: AbortSignal,
): Promise<void> {
  const errors: string[] = []
  const gaps: string[] = []
  const behind: string[] = []
  const history = !link.missing.has('history')
  for (const { chatId } of config.chats) {
    if (signal.aborted) return
    const started = new Date().toISOString()
    const cursorKey = KV.feishu.history(chatId)
    const since = ctx.state.get(cursorKey)
    if (since === undefined || !history) {
      ctx.state.set(cursorKey, started)
      continue
    }
    try {
      // The cursor follows each slice read, so a round that fails part way resumes after what it read.
      const recovery = await backfillChat(ctx, link, chatId, since, started, signal, (at) =>
        ctx.state.set(cursorKey, at),
      )
      if (recovery.behind) behind.push(`${chatId}: recovered up to ${recovery.behind}`)
      else if (!signal.aborted) ctx.state.set(cursorKey, cursorAt(started))
      for (const window of recovery.skipped)
        gaps.push(
          `${chatId}: skipped ${window.from} to ${window.to}, more messages than the channel reads at once`,
        )
    } catch (error) {
      if (!signal.aborted) errors.push(`${chatId}: ${errorText(error)}`)
    }
  }
  if (!link.missing.has('threads')) await pollThreads(ctx, link, signal)
  if (signal.aborted) return
  if (!history) report(ctx, link, 'history', health('paused', 'feishuNoHistory'))
  else
    report(
      ctx,
      link,
      'history',
      errors.length
        ? { state: 'error', detail: errors.join('\n') }
        : gaps.length
          ? { state: 'error', detail: `Listed chats recovered with gaps:\n${gaps.join('\n')}` }
          : behind.length
            ? {
                state: 'ready',
                detail: `Catching up on chat history:\n${behind.join('\n')}`,
                at: new Date().toISOString(),
              }
            : { state: 'ready', detail: 'Listed chats recovered', at: new Date().toISOString() },
    )
}
/** The longest stretch of chat history one read covers, so the host's page bound holds in a busy chat. */
export const HISTORY_SLICE_MS = 3_600_000
/** How many slices one round reads per chat, so a long outage is caught up over rounds rather than in one burst. */
export const HISTORY_SLICES_PER_ROUND = 24
/** What a recovery left out: windows the channel refused as too large, and where it stopped when the gap was longer. */
export interface Recovery {
  skipped: { from: string; to: string }[]
  /** The end of the last slice read when the round's slices ran out before `until`; the next round goes on from it. */
  behind?: string
}
const iso = (time: number) => new Date(time).toISOString()
/**
 * Recovers a chat's messages and its active topics' messages between `since` and `until`, however long the gap, as DSH
 * did. The chat is read an hour at a time, at most `HISTORY_SLICES_PER_ROUND` hours per call: `advance` receives the end
 * of each hour read short of `until`, and a gap longer than that ends at `behind` for the next round. An hour the channel
 * refuses as too large is skipped and named rather than read again. Topics are stored as `{ id: lastSeenAt }`, and quiet
 * topics no polled Thread follows are pruned.
 */
export async function backfillChat(
  ctx: SourceContext,
  link: FeishuLink,
  chatId: string,
  since: string,
  until: string,
  signal: AbortSignal,
  advance: (at: string) => void = () => {},
): Promise<Recovery> {
  const recovery: Recovery = { skipped: [] }
  const end = Date.parse(until)
  const start = Date.parse(since)
  const io = ioOf(ctx, link, signal)
  const topicsKey = KV.feishu.topics(chatId)
  const topics = { ...ctx.state.get(topicsKey) }
  const seen = (event: MessageEvent) => {
    const topic = event.chat.threadId
    if (topic && !(Date.parse(topics[topic] ?? '') >= Date.parse(event.at)))
      topics[topic] = new Date(Date.parse(event.at)).toISOString()
  }
  for (let from = start, slices = 0; from < end; slices++) {
    if (slices === HISTORY_SLICES_PER_ROUND) {
      recovery.behind = iso(from)
      break
    }
    const to = Math.min(from + HISTORY_SLICE_MS, end)
    let events: MessageEvent[] = []
    try {
      events = await readHistory(io, chatId, from, to)
    } catch (error) {
      if (channelCode(error) !== 'CHANNEL_READ_TOO_LARGE') throw error
      recovery.skipped.push({ from: iso(from), to: iso(to) })
    }
    for (const event of events) {
      signal.throwIfAborted()
      seen(event)
      await takeIn(ctx, link, event)
    }
    from = to
    if (from < end) advance(iso(from))
  }
  // A quiet topic is forgotten unless a subscribed Thread that is still polled follows it.
  const followed = new Set(
    ctx.threads
      .subscribed(SOURCE)
      .filter((thread) => polled(ctx, thread))
      .map((thread) => String(thread.meta.threadId ?? ctx.triggers.latest(thread.key)?.meta.threadId ?? '')),
  )
  for (const [id, last] of Object.entries(topics)) {
    if (!followed.has(id) && Date.parse(until) - Date.parse(last) >= POLL_HORIZON_MS) delete topics[id]
  }
  ctx.state.set(topicsKey, topics)
  if (link.missing.has('threads')) return recovery
  for (const id of Object.keys(topics)) {
    const recent = await readTopic(io, chatId, id, 50, 'desc')
    for (const event of recent.reverse()) {
      signal.throwIfAborted()
      if (Date.parse(event.at) < start) continue
      seen(event)
      await takeIn(ctx, link, event)
    }
  }
  ctx.state.set(topicsKey, topics)
  return recovery
}

/** Resolves the retained source message reference for polling a subscribed thread. */
export function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined {
  const trigger = ctx.triggers.latest(thread.key)
  const meta = thread.meta as { sourceTriggerId?: string; chatId?: string; messageId?: string }
  const ref = trigger ? feishuRef(trigger) : undefined
  if (meta.chatId && meta.messageId && meta.sourceTriggerId)
    return { ...ref, triggerId: meta.sourceTriggerId, chatId: meta.chatId, messageId: meta.messageId }
  return ref
}
/** Polls subscribed Feishu topics within the polling horizon so replies the subscription missed become triggers. */
export async function pollThreads(ctx: SourceContext, link: FeishuLink, signal?: AbortSignal): Promise<void> {
  await pollEach(
    ctx,
    SOURCE,
    () => !!signal?.aborted,
    (thread) => pollThread(ctx, link, thread, signal),
  )
}
/**
 * Reads the newest messages of a subscribed Thread's topic and takes in those not seen before; on the first poll,
 * messages older than the Thread are only marked seen. A Thread outside a topic is left to the subscription and history.
 */
async function pollThread(ctx: SourceContext, link: FeishuLink, thread: Thread, signal?: AbortSignal) {
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('Subscribed thread has no retained source message')
  const config = enabled(ctx)
  // The Source was turned off; the next round polls again.
  if (!config) return
  const topic = String(thread.meta.threadId ?? ref.threadId ?? '')
  if (!topic) return
  const checkpoint = KV.feishu.seen(thread.key)
  const known = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.feishu.initialized(thread.key))
  const since = Date.parse(thread.createdAt)
  const events = await readTopic(ioOf(ctx, link, signal), ref.chatId, topic, 50, 'desc')
  for (const event of [...events].reverse()) {
    if (signal?.aborted) return
    if (known.has(event.messageId)) continue
    // Messages older than the subscription are history, not news, on the first poll.
    if (!initialized && Date.parse(event.at) < since) continue
    await takeIn(ctx, link, event)
  }
  for (const event of events) known.add(event.messageId)
  ctx.state.set(checkpoint, [...known].slice(-REMEMBERED))
  ctx.state.set(KV.feishu.initialized(thread.key), true)
}
