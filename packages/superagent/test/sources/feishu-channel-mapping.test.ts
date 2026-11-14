// Adapted from dsh-superagent (MIT)
/**
 * The Feishu Source over the AGH channel (sources `feishu*.ts`): channel messages become the Triggers the DSH lark-cli
 * events made, replies go through the channel under the asked message, members come from the channel's member list,
 * and history is recovered through `listHistory` and the subscribed topics' `listThread`. The DSH Feishu cases are
 * rewritten here with channel input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourcesStatus } from '../../src/app/views/sources.js'
import { key, type OutboundMessage } from '../../src/core/index.js'
import { KV } from '../../src/kv.js'
import {
  backfillChat,
  consumerRetry,
  feishuRef,
  feishuTime,
  feishuTrigger,
  messageTrigger,
  pollThreads,
  takeIn,
} from '../../src/sources/feishu.js'
import { recoverRound } from '../../src/sources/feishu-loops.js'
import { feishuChannel } from '../../src/sources/feishu-trigger.js'
import { fakeChannels, message, rpc } from './fake-channels.js'
import { type FeishuHost, feishuHost, MEMBER } from './feishu-host.js'

const hosts: FeishuHost[] = []
const open = (...args: Parameters<typeof feishuHost>) => {
  const host = feishuHost(...args)
  hosts.push(host)
  return host
}
afterEach(() => {
  vi.useRealTimers()
  for (const host of hosts.splice(0)) host.close()
})
const reply = (id: string, to: string, text = 'On it.'): OutboundMessage =>
  ({ id, kind: 'reply', text, channel: feishuChannel('oc_team', to) }) as OutboundMessage

describe('channel messages as Triggers', () => {
  it('maps a group @ message, a topic reply, a bot sender and an image attachment into the Triggers lark-cli events made', () => {
    const at = '2025-09-09T00:00:00.000Z'
    // The DSH event consumer printed the same messages in these shapes, with the bot `ou_bot` / `cli_bot`.
    const lark = (fields: Record<string, unknown>) =>
      feishuTrigger(
        {
          chat_id: 'oc_team',
          chat_type: 'group',
          sender_type: 'user',
          create_time: '1757376000000',
          ...fields,
        },
        'ou_bot',
        'cli_bot',
      )
    const mention = message('om_1', { at, text: '@Bot fix the title', mentioned: true })
    expect(messageTrigger(mention, 'om_1')).toEqual(
      lark({
        message_id: 'om_1',
        sender_id: MEMBER,
        content: '@Bot fix the title',
        mentions: [{ id: 'cli_bot' }],
      }),
    )
    expect(messageTrigger(mention, 'om_1')).toMatchObject({
      id: key('feishu', 'om_1'),
      threads: [{ source: 'feishu', id: 'oc_team:om_1' }],
      addressed: 'mention',
      human: true,
      meta: { chatId: 'oc_team', messageId: 'om_1', mentioned: true, direct: false },
    })
    const topic = message('om_2', { at, text: 'and the header', thread: 'omt_1', quoted: 'om_1' })
    expect(messageTrigger(topic, 'om_1')).toEqual(
      lark({
        message_id: 'om_2',
        sender_id: MEMBER,
        content: 'and the header',
        root_id: 'om_1',
        parent_id: 'om_1',
        thread_id: 'omt_1',
      }),
    )
    expect(messageTrigger(topic, 'om_1')).toMatchObject({ threads: [{ id: 'oc_team:om_1' }] })
    const bot = message('om_3', { at, text: 'build failed', sender: 'cli_ci', bot: true })
    expect(messageTrigger(bot, 'om_3')).toEqual(
      lark({ message_id: 'om_3', sender_id: 'cli_ci', sender_type: 'bot', content: 'build failed' }),
    )
    expect(messageTrigger(bot, 'om_3')?.human).toBe(false)
    // An image attachment is named in the text by the key an assessment reads it with, as lark-cli named image keys.
    const image = message('om_4', {
      at,
      text: 'see this',
      attachments: [
        { name: 'a.txt', mime: 'text/plain' },
        { name: 'shot.png', mime: 'image/png', bytes: new Uint8Array([1]) },
      ],
    })
    expect(messageTrigger(image, 'om_4')?.text).toBe('see this\n[image img_att_2]')
    expect(feishuRef(messageTrigger(topic, 'om_1')!)).toEqual({
      triggerId: key('feishu', 'om_2'),
      chatId: 'oc_team',
      messageId: 'om_2',
      at,
      rootId: 'om_1',
      parentId: 'om_1',
      threadId: 'omt_1',
    })
  })
  it("drops the bot's own messages once one of its replies came back, and before that by the reply's id", async () => {
    const h = open()
    const sent = await h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1', 'om_1'))
    expect(sent).toBe('sent')
    // The reply comes back through the subscription: it teaches the Source the bot's id and is no Trigger.
    expect(await takeIn(h.ctx, h.link, message('om_sent1', { sender: 'ou_bot', bot: true }))).toBe('own')
    expect(h.ctx.state.get(KV.feishu.self)).toBe('ou_bot')
    expect(await takeIn(h.ctx, h.link, message('om_9', { sender: 'ou_bot', bot: true }))).toBe('own')
    expect(h.receive).not.toHaveBeenCalled()
  })
  it("drops every part of the bot's reply that comes back while it is being sent, without taking another bot for itself", async () => {
    const h = open()
    await takeIn(h.ctx, h.link, message('om_1', { mentioned: true }))
    let release = () => {}
    h.fake.state.sendHold = new Promise((resolve) => {
      release = resolve
    })
    h.fake.state.nextIds = ['om_p1']
    const sending = h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1', 'om_1'))
    await Promise.resolve()
    // Two parts of the reply come back before the send returns (it returns only the first part's id).
    const part = (id: string) => message(id, { sender: 'ou_bot', bot: true, quoted: 'om_1' })
    expect(await takeIn(h.ctx, h.link, part('om_p1'))).toBe('own')
    expect(await takeIn(h.ctx, h.link, part('om_p2'))).toBe('own')
    // A bot message that answers the request after the send is no part of it.
    release()
    expect(await sending).toBe('sent')
    expect(
      await takeIn(h.ctx, h.link, message('om_ci', { sender: 'cli_ci', bot: true, quoted: 'om_1' })),
    ).toBe('stored')
    // Nothing taught the bot's id from a message that may be another bot's; history reads the parts as the bot's.
    expect(h.ctx.state.get(KV.feishu.self)).toBeUndefined()
    expect(await takeIn(h.ctx, h.link, part('om_p2'))).toBe('own')
    expect(await takeIn(h.ctx, h.link, part('om_p1'))).toBe('own')
    expect(h.ctx.state.get(KV.feishu.self)).toBe('ou_bot')
    expect(h.trigger('om_p1')).toBeUndefined()
    expect(h.trigger('om_p2')).toBeUndefined()
  })
  it("learns the bot's id from its reply's first part when that part came back and was taken in before the send returned", async () => {
    const h = open()
    await takeIn(h.ctx, h.link, message('om_1', { mentioned: true }))
    // The part came back without quoting the request, so it was taken in as some bot's message.
    expect(await takeIn(h.ctx, h.link, message('om_p1', { sender: 'ou_bot', bot: true }))).toBe('stored')
    h.fake.state.nextIds = ['om_p1']
    await h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1', 'om_1'))
    expect(h.ctx.state.get(KV.feishu.self)).toBe('ou_bot')
    expect(await takeIn(h.ctx, h.link, message('om_p9', { sender: 'ou_bot', bot: true }))).toBe('own')
  })
  it('makes a message of a listed bot an inferred candidate, and admits no other bot', async () => {
    const h = open()
    expect(
      await takeIn(h.ctx, h.link, message('om_ci', { chat: 'oc_observed', sender: 'cli_ci', bot: true })),
    ).toBe('stored')
    await takeIn(h.ctx, h.link, message('om_x', { chat: 'oc_observed', sender: 'cli_other', bot: true }))
    expect(h.assessor.request).toHaveBeenCalledTimes(1)
    expect(vi.mocked(h.assessor.request).mock.calls[0]![0].triggers.map((t) => t.id)).toEqual([
      key('feishu', 'om_ci'),
    ])
  })
  it('reads message times given as epoch milliseconds, local times or ISO times, and refuses others', () => {
    expect(feishuTime('1757376000000')).toBe('2025-09-09T00:00:00.000Z')
    expect(feishuTime('2026-09-11 12:00')).toBe(new Date(2026, 8, 11, 12, 0).toISOString())
    expect(feishuTime('2026-11-14T08:00:00.000Z')).toBe('2026-11-14T08:00:00.000Z')
    expect(() => feishuTime('soon')).toThrow('Unreadable Feishu message time')
  })
})

describe('follow-ups', () => {
  it("puts a topic reply on its topic's Thread, by the recorded root or the topic's first message", async () => {
    const fake = fakeChannels({
      history: [message('om_root', { thread: 'omt_1' }), message('om_r1', { thread: 'omt_1' })],
    })
    const h = open({ fake })
    await takeIn(h.ctx, h.link, message('om_r1', { thread: 'omt_1', at: '2026-11-14T08:01:00.000Z' }))
    expect(h.trigger('om_r1')?.threads).toEqual([{ source: 'feishu', id: 'oc_team:om_root' }])
    expect(fake.calls('listThread')).toHaveLength(1)
    // The root is recorded; the next reply of the topic reads nothing.
    await takeIn(h.ctx, h.link, message('om_r2', { thread: 'omt_1', at: '2026-11-14T08:02:00.000Z' }))
    expect(h.trigger('om_r2')?.threads).toEqual([{ source: 'feishu', id: 'oc_team:om_root' }])
    expect(fake.calls('listThread')).toHaveLength(1)
  })
  it("puts a quote of a ticket's message or of the bot's reply on that Thread when the channel names no topic", async () => {
    const fake = fakeChannels({ reads: { messages: false, threads: false, history: false, members: false } })
    const h = open({ fake })
    await takeIn(h.ctx, h.link, message('om_1', { mentioned: true }))
    await h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1', 'om_1'))
    expect(fake.sent[0]!.target).toEqual({
      chatType: 'group',
      chatId: 'oc_team',
      threadId: 'om_1',
      deliveryKey: 'r1',
    })
    // A quote of the request, and a quote of the bot's reply, join the request's Thread.
    await takeIn(h.ctx, h.link, message('om_2', { quoted: 'om_1' }))
    await takeIn(h.ctx, h.link, message('om_3', { quoted: 'om_sent1' }))
    // A quote of a message the Source does not know starts a chain at it; any other message starts its own.
    await takeIn(h.ctx, h.link, message('om_4', { quoted: 'om_unknown' }))
    await takeIn(h.ctx, h.link, message('om_5'))
    expect(['om_2', 'om_3', 'om_4', 'om_5'].map((id) => h.trigger(id)?.threads[0]?.id)).toEqual([
      'oc_team:om_1',
      'oc_team:om_1',
      'oc_team:om_unknown',
      'oc_team:om_5',
    ])
  })
  it('takes in a message once, however often the channel or history delivers it', async () => {
    const h = open()
    expect(await takeIn(h.ctx, h.link, message('om_1', { mentioned: true }))).toBe('stored')
    expect(await takeIn(h.ctx, h.link, message('om_1', { mentioned: true, eventId: 'ev-redelivered' }))).toBe(
      'duplicate',
    )
    expect(h.receive).toHaveBeenCalledTimes(1)
  })
})

describe('replies', () => {
  it('replies in the topic under the asked message, with the outgoing id as delivery key on every retry', async () => {
    const h = open()
    await takeIn(h.ctx, h.link, message('om_root', { thread: 'omt_1' }))
    await takeIn(h.ctx, h.link, message('om_r1', { thread: 'omt_1', quoted: 'om_root', mentioned: true }))
    h.fake.state.sendErrors.push(new Error('socket hang up'))
    await expect(h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1', 'om_r1'))).rejects.toThrow(
      'socket hang up',
    )
    expect(await h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1', 'om_r1'))).toBe('sent')
    const sends = h.fake.calls('send').map((call) => call.args)
    expect(sends).toHaveLength(2)
    for (const [channel, target, body] of sends)
      expect({ channel, target, body }).toEqual({
        channel: 'feishu',
        target: { chatType: 'group', chatId: 'oc_team', threadId: 'omt_1', deliveryKey: 'r1' },
        body: {
          blocks: [{ kind: 'text', markdown: 'On it.' }],
          replyTo: { chatId: 'oc_team', messageId: 'om_r1', chatType: 'group' },
        },
      })
  })
  it('drops a reply to a recalled message, and keeps one whose send timed out for a retry whatever its text says', async () => {
    const h = open()
    h.fake.state.sendErrors.push(
      new Error('Feishu refused the reply: message recalled (230011)'),
      { ...rpc('SEMANTIC_REJECTED', 'FEISHU_API'), data: { code: 'FEISHU_API', feishu: 230011 } },
      new Error('The message was withdrawn'),
      new Error('send timed out after 90 s: withdrawn draft'.replace('withdrawn draft', 'draft')),
    )
    const send = () => h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1', 'om_1'))
    expect(await send()).toBe('gone')
    expect(await send()).toBe('gone')
    expect(await send()).toBe('gone')
    await expect(send()).rejects.toThrow('timed out')
  })
  it('refuses a reply while the Source names no channel instance', async () => {
    const h = open({ feishu: { channel: '' } })
    await expect(h.kind.channel!.send({ commands: h.ctx.commands }, reply('r1', 'om_1'))).rejects.toThrow(
      'no channel instance',
    )
    expect(h.fake.calls('send')).toEqual([])
  })
})

describe('allowlist sync', () => {
  it('syncs its part of the Policy from the sync chat: people who left are removed, names follow the chat, new people are appended', async () => {
    const fake = fakeChannels({
      members: {
        oc_team: [
          { userId: 'ou_carol', displayName: 'Carol' },
          { userId: MEMBER, displayName: 'Alice Li' },
        ],
      },
    })
    const h = open({ fake })
    const sync = h.kind.policy!.sync!
    expect(sync.ready({ allowed: [] })).toBe(false)
    expect(
      await sync.run(
        h.host,
        {
          allowed: [
            { id: MEMBER, name: 'Alice' },
            { id: 'ou_bob', name: 'Bob' },
          ],
          syncChat: 'oc_team',
        },
        new AbortController().signal,
      ),
    ).toEqual({
      allowed: [
        { id: MEMBER, name: 'Alice Li' },
        { id: 'ou_carol', name: 'Carol' },
      ],
      syncChat: 'oc_team',
    })
    expect(fake.calls('listMembers').map((call) => call.args)).toEqual([['oc_team']])
  })
  it('keeps the allowlist in the settings when the channel cannot list members, and offers no sync then', async () => {
    const h = open({ fake: fakeChannels({ reads: { members: false } }) })
    const sync = h.kind.policy!.sync!
    const part = { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: 'oc_team' }
    expect(sync.ready(part)).toBe(true)
    expect(await sync.run(h.host, part, new AbortController().signal)).toBe(part)
    expect(sync.ready(part)).toBe(false)
  })
})

describe('history recovery', () => {
  const minutes = (n: number) => new Date(Date.parse('2026-11-14T08:00:00.000Z') + n * 60_000).toISOString()
  it("recovers a chat's messages through listHistory in the window since its cursor, and its active topics through listThread", async () => {
    const fake = fakeChannels({
      history: [
        message('om_old', { at: minutes(-5), mentioned: true }),
        message('om_new', { at: minutes(0.5), mentioned: true }),
        message('om_t0', { at: minutes(-3), thread: 'omt_1' }),
        message('om_t1', { at: minutes(0.7), thread: 'omt_1' }),
      ],
    })
    const h = open({ fake })
    h.ctx.state.set(KV.feishu.topics('oc_team'), { omt_1: minutes(-3) })
    await backfillChat(h.ctx, h.link, 'oc_team', minutes(0), minutes(1), new AbortController().signal)
    expect(fake.calls('listHistory').map((call) => call.args)).toEqual([
      ['oc_team', { start: minutes(0), end: minutes(1) }],
    ])
    expect(fake.calls('listThread').map((call) => call.args[1])).toContain('omt_1')
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_new', 'om_t1'])
    expect(h.ctx.state.get(KV.feishu.topics('oc_team'))).toEqual({ omt_1: minutes(0.7) })
  })
  it('recovers a gap of 30 days in full over rounds of at most 24 hours read, skipping and naming an hour the channel refuses as too large', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = Date.parse('2026-11-14T08:00:00.000Z')
    vi.setSystemTime(now)
    const hour = 3_600_000
    const at = (ago: number) => new Date(now - ago).toISOString()
    const h = open({ feishu: { chats: [{ chatId: 'oc_team', listen: 'mentions' }] } })
    h.link.listening = true
    h.ctx.state.set(KV.feishu.history('oc_team'), at(30 * 24 * hour))
    let reads: { start: string; end: string }[] = []
    h.fake.channels.listHistory = async (_channel, _chat, opts) => {
      reads.push(opts)
      // One busy hour is more than the host joins in one read; a request 29 days ago and one after the busy hour.
      if (opts.start === at(3 * hour)) throw rpc('SEMANTIC_REJECTED', 'CHANNEL_READ_TOO_LARGE')
      if (opts.start === at(29 * 24 * hour))
        return [message('om_old', { at: now - 29 * 24 * hour + 1000, mentioned: true })]
      if (opts.start === at(2 * hour))
        return [message('om_late', { at: now - 2 * hour + 1000, mentioned: true })]
      return []
    }
    const perRound: number[] = []
    const all: { start: string; end: string }[] = []
    for (let round = 0; round < 40; round++) {
      reads = []
      await recoverRound(h.ctx, h.link, h.ctx.config('feishu')!, new AbortController().signal)
      perRound.push(reads.length)
      all.push(...reads)
      if (h.ctx.state.get(KV.feishu.history('oc_team')) === at(5000)) break
      // Until then the cursor stands at the end of what the round read, and the Source says it is catching up.
      expect(h.ctx.state.get(KV.feishu.history('oc_team'))).toBe(all.at(-1)?.end)
      expect(h.health.history).toMatchObject({ state: 'ready' })
      expect(h.health.history?.detail).toContain(
        `Catching up on chat history:\noc_team: recovered up to ${all.at(-1)?.end}`,
      )
    }
    // Thirty rounds of 24 hours each read every hour of the gap once, from its start.
    expect(perRound).toEqual(Array(30).fill(24))
    expect(all[0]).toEqual({ start: at(30 * 24 * hour), end: at(30 * 24 * hour - hour) })
    expect(new Set(all.map((read) => read.start)).size).toBe(30 * 24)
    expect(h.trigger('om_old')).toBeDefined()
    expect(h.trigger('om_late')).toBeDefined()
    expect(h.health.history).toMatchObject({ state: 'error' })
    expect(h.health.history?.detail).toContain(`oc_team: skipped ${at(3 * hour)} to ${at(2 * hour)}`)
    // The next round reads only what came since.
    reads = []
    vi.setSystemTime(now + 60_000)
    await recoverRound(h.ctx, h.link, h.ctx.config('feishu')!, new AbortController().signal)
    expect(reads).toEqual([{ start: at(5000), end: new Date(now + 60_000).toISOString() }])
    expect(h.health.history).toMatchObject({ state: 'ready', detail: 'Listed chats recovered' })
  })
  it('keeps a quiet topic in history recovery while a subscribed Thread that is polled follows it', async () => {
    const day = 24 * 3600_000
    const old = new Date(Date.now() - 30 * day).toISOString()
    const root = message('om_root', { at: old, thread: 'omt_followed' })
    const h = open({ fake: fakeChannels({ history: [root] }) })
    await takeIn(h.ctx, h.link, root)
    const thread = h.store.threads.get('feishu:oc_team:om_root')!
    h.store.threads.save({ ...thread, subscriptions: ['ticket'], lastAt: new Date().toISOString() })
    h.ctx.state.set(KV.feishu.topics('oc_team'), { omt_followed: old, omt_quiet: old })
    const now = new Date().toISOString()
    await backfillChat(
      h.ctx,
      h.link,
      'oc_team',
      new Date(Date.now() - 60_000).toISOString(),
      now,
      new AbortController().signal,
    )
    expect(h.ctx.state.get(KV.feishu.topics('oc_team'))).toEqual({ omt_followed: old })
  })
  it('refuses a history page with a message outside its chat or topic, and passes on a cursor the channel says stalled', async () => {
    const fake = fakeChannels()
    const h = open({ fake })
    const recover = () =>
      backfillChat(h.ctx, h.link, 'oc_team', minutes(0), minutes(1), new AbortController().signal)
    fake.state.history = [message('om_1', { at: minutes(0.5), chat: 'oc_team' })]
    fake.channels.listHistory = async () => [message('om_1', { at: minutes(0.5), chat: 'oc_other' })]
    await expect(recover()).rejects.toThrow('outside the requested chat')
    fake.channels.listHistory = async () => []
    h.ctx.state.set(KV.feishu.topics('oc_team'), { omt_1: minutes(0) })
    fake.channels.listThread = async () => [message('om_2', { at: minutes(0.5), thread: 'omt_2' })]
    await expect(recover()).rejects.toThrow('outside the source thread')
    fake.channels.listHistory = async () => {
      throw rpc('SEMANTIC_REJECTED', 'CHANNEL_CURSOR_STALLED')
    }
    await expect(recover()).rejects.toMatchObject({ data: { code: 'CHANNEL_CURSOR_STALLED' } })
  })
  it('recovers the topics of a chat while they had a message in the last two weeks, and forgets quieter ones', async () => {
    const h = open()
    const day = 24 * 3600_000
    const start = Date.parse('2026-09-01T00:00:00.000Z')
    h.ctx.state.set(KV.feishu.topics('oc_team'), { omt_old: new Date(start).toISOString() })
    let round = 0
    const scans: string[] = []
    h.fake.channels.listHistory = async (_channel, chatId) => {
      scans.push(chatId)
      return [message(`om_${round}`, { at: start + round * day, thread: `omt_${round}` })]
    }
    h.fake.channels.listThread = async (_channel, _chat, threadId, opts) => {
      // A topic's first message is read once to find its root; the recovery reads the topic's recent page.
      if (opts.limit > 1) scans.push(threadId)
      return []
    }
    for (round = 0; round < 30; round++) {
      scans.length = 0
      await backfillChat(
        h.ctx,
        h.link,
        'oc_team',
        new Date(start + round * day - 60_000).toISOString(),
        new Date(start + round * day + 60_000).toISOString(),
        new AbortController().signal,
      )
      if (round === 0) expect(scans).toContain('omt_old')
    }
    // The chat, and the topics with a message in the last 14 days.
    expect(scans).toHaveLength(1 + 14)
    const topics = h.ctx.state.get(KV.feishu.topics('oc_team'))!
    expect(Object.keys(topics)).toHaveLength(14)
    expect(topics.omt_29).toBe(new Date(start + 29 * day).toISOString())
  })
  it("recovers nothing without a history read, which the history health says, and keeps the chat's cursor at the round", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open({ fake: fakeChannels({ reads: { history: false } }) })
    const controller = new AbortController()
    const running = h.run(controller.signal)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.health.history).toMatchObject({ state: 'paused', code: 'feishuNoHistory' })
    expect(h.health.history?.detail).toContain('cannot read chat history')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.fake.calls('listHistory').filter((call) => call.args[0] !== '')).toEqual([])
    controller.abort()
    await running
  })
})

describe('subscribed topics', () => {
  it('polls subscribed topics and stores unseen replies as triggers on that Thread, skipping what came before it', async () => {
    const fake = fakeChannels()
    const h = open({ fake })
    await takeIn(h.ctx, h.link, message('om_root', { mentioned: true, at: '2026-11-14T08:00:00.000Z' }))
    const thread = h.store.threads.get('feishu:oc_team:om_root')!
    h.store.threads.save({
      ...thread,
      createdAt: '2026-11-14T08:00:00.000Z',
      subscriptions: ['ticket'],
      lastAt: new Date().toISOString(),
      meta: { ...thread.meta, threadId: 'omt_1' },
    })
    h.ctx.state.set(KV.feishu.roots, { omt_1: 'om_root' })
    fake.state.history = [
      message('om_earlier', { thread: 'omt_1', at: '2026-11-14T07:00:00.000Z' }),
      message('om_reply', {
        thread: 'omt_1',
        sender: 'ou_guest',
        text: 'more details',
        at: '2026-11-14T08:05:00.000Z',
      }),
    ]
    h.receive.mockClear()
    await pollThreads(h.ctx, h.link)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({
      id: key('feishu', 'om_reply'),
      threads: [{ source: 'feishu', id: 'oc_team:om_root' }],
      actor: { id: 'ou_guest' },
      text: 'more details',
      meta: expect.objectContaining({ threadId: 'omt_1', rootId: 'om_root' }),
    })
    expect(h.ctx.state.get(KV.feishu.seen(thread.key))).toEqual(
      expect.arrayContaining(['om_reply', 'om_earlier']),
    )
    // A later poll takes in only a reply it has not seen.
    fake.state.history.push(message('om_more', { thread: 'omt_1', at: '2026-11-14T08:06:00.000Z' }))
    h.receive.mockClear()
    await pollThreads(h.ctx, h.link)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_more'])
    fake.channels.listThread = async () => {
      throw new Error('rate limited')
    }
    await pollThreads(h.ctx, h.link)
    expect(h.store.threads.get(thread.key)?.meta.pollError).toContain('rate limited')
  })
  it('polls a subscribed topic while a live ticket follows it or it had a message in the last two weeks', async () => {
    const fake = fakeChannels({ history: [message('om_root', { thread: 'omt_1' })] })
    const h = open({ fake })
    await takeIn(h.ctx, h.link, message('om_root', { thread: 'omt_1' }))
    const thread = h.store.threads.get('feishu:oc_team:om_root')!
    h.store.threads.save({
      ...thread,
      subscriptions: ['ticket'],
      lastAt: new Date(Date.now() - 15 * 24 * 3600_000).toISOString(),
    })
    const before = fake.calls('listThread').length
    await pollThreads(h.ctx, h.link)
    expect(fake.calls('listThread')).toHaveLength(before)
    h.store.tickets.save({
      id: 'ticket',
      title: 'ticket',
      decisionId: 'd',
      mandate: {
        strength: 'explicit',
        policyVersion: '',
        basis: { via: 'listed' },
        actor: { source: 'feishu', id: MEMBER },
        scope: '',
      },
      channels: [],
      assignments: [],
      inputs: [],
      undelivered: [],
      createdAt: '',
      updatedAt: '',
      origin: { triggerId: 'x', triggerIds: [] },
    })
    await pollThreads(h.ctx, h.link)
    expect(fake.calls('listThread').length).toBeGreaterThan(before)
  })
})

describe('the subscription', () => {
  it('registers its kind, and names on its health what setup still needs: a channel instance, chats, a running channel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const unset = open({ feishu: { channel: '' } })
    expect(unset.sources.kind('feishu')).toBe(unset.kind)
    const stop = new AbortController()
    let running = unset.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(unset.health.feishu).toMatchObject({ state: 'paused', code: 'feishuChannelUnset' })
    expect(unset.health.feishu?.detail).toMatch(/^Setup required: .*channel instance/)
    // What listening brings waits for it, so the Source shows paused, not starting.
    for (const entry of ['history', 'members', 'reads'])
      expect(unset.health[entry]).toMatchObject({ state: 'paused', code: 'feishuWaiting' })
    expect(
      sourcesStatus({ store: unset.store, sources: unset.sources, links: {} as never }, unset.health, {}),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'feishu', state: 'paused' })]))
    stop.abort()
    await running
    const pending = open({ configured: () => false })
    const stopped = new AbortController()
    running = pending.run(stopped.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(pending.health.feishu).toMatchObject({ state: 'paused', code: 'setupPending' })
    stopped.abort()
    await running
    const chats = open({ feishu: { chats: [] } })
    const ended = new AbortController()
    running = chats.run(ended.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(chats.health.feishu).toMatchObject({ state: 'paused', code: 'feishuChatsUnset' })
    ended.abort()
    await running
  })
  it('reports a refused subscription as setup still required, retries it with backoff, and listens once the channel runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const fake = fakeChannels({ running: false })
    const h = open({ fake })
    const stop = new AbortController()
    const running = h.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.health.feishu).toMatchObject({
      state: 'paused',
      code: 'feishuChannelRefused',
      values: { channel: 'feishu', reason: 'CHANNEL_UNAVAILABLE' },
    })
    expect(h.health.feishu?.detail).toMatch(/^Setup required: the channel instance feishu refused/)
    // One second, then two, then four: three attempts within seven seconds, none failing for good.
    await vi.advanceTimersByTimeAsync(3_500)
    expect(fake.calls('subscribe')).toHaveLength(3)
    fake.state.running = true
    await vi.advanceTimersByTimeAsync(4_500)
    expect(fake.subscribed().sort()).toEqual(['oc_observed', 'oc_team'])
    expect(h.health.feishu).toMatchObject({ state: 'ready', detail: 'Listening to 2 chats on feishu' })
    expect(h.logs.some((line) => line.includes('refused the chats (CHANNEL_UNAVAILABLE)'))).toBe(true)
    // Each change is kept with the Source's records, as last changed.
    expect(h.ctx.state.get(KV.feishu.health)?.feishu).toMatchObject({
      state: 'ready',
      detail: 'Listening to 2 chats on feishu',
    })
    stop.abort()
    await running
  })
  it('takes in the messages the subscription delivers, reports a failed take-in as an error and goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open()
    const stop = new AbortController()
    const running = h.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    h.receive.mockRejectedValueOnce(new Error('store busy'))
    h.fake.emit(message('om_bad', { mentioned: true }))
    h.fake.emit(message('om_good', { mentioned: true }))
    await vi.advanceTimersByTimeAsync(10)
    expect(h.health.feishu).toMatchObject({ state: 'error', detail: 'store busy' })
    expect(h.trigger('om_good')).toBeDefined()
    stop.abort()
    await running
  })
  it('drops what the subscription delivers once the Source is off, and unsubscribes within five seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open()
    const stop = new AbortController()
    const running = h.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    const settings = h.store.settings()
    h.store.saveSettings({
      ...settings,
      sources: { ...settings.sources, feishu: { ...settings.sources.feishu!, enabled: false } },
    })
    h.fake.emit(message('om_late', { mentioned: true }))
    await vi.advanceTimersByTimeAsync(5_100)
    expect(h.trigger('om_late')).toBeUndefined()
    expect(h.fake.subscribed()).toEqual([])
    expect(h.health.feishu).toMatchObject({ state: 'paused', code: 'sourceOff' })
    stop.abort()
    await running
  })
  it('subscribes again when the channel or the chats change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open()
    const stop = new AbortController()
    const running = h.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    const settings = h.store.settings()
    const feishu = settings.sources.feishu!
    h.store.saveSettings({
      ...settings,
      sources: {
        ...settings.sources,
        feishu: { ...feishu, config: { ...feishu.config, chats: [{ chatId: 'oc_new', listen: 'all' }] } },
      },
    })
    await vi.advanceTimersByTimeAsync(5_100)
    expect(h.fake.calls('subscribe').map((call) => call.args)).toEqual([
      ['feishu', ['oc_team', 'oc_observed']],
      ['feishu', ['oc_new']],
    ])
    expect(h.fake.subscribed()).toEqual(['oc_new'])
    stop.abort()
    await running
  })
  it('waits a second before subscribing again after a refusal, doubling up to a minute', () => {
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(1000, 0)).toBe(2000)
    expect(consumerRetry(32_000, 0)).toBe(60_000)
    expect(consumerRetry(60_000, 120_000)).toBe(1000)
  })
  it('catches up on the chats at once after a new subscription, from each chat cursor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    vi.setSystemTime(Date.parse('2026-11-14T08:00:00.000Z'))
    const fake = fakeChannels({ running: false })
    const h = open({ fake })
    h.ctx.state.set(KV.feishu.history('oc_team'), '2026-11-14T07:59:00.000Z')
    fake.state.history = [message('om_missed', { at: '2026-11-14T07:59:30.000Z', mentioned: true })]
    const stop = new AbortController()
    const running = h.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.trigger('om_missed')).toBeUndefined()
    fake.state.running = true
    await vi.advanceTimersByTimeAsync(1_100)
    expect(h.trigger('om_missed')).toBeDefined()
    stop.abort()
    await running
  })
})

describe('direct messages and other chats', () => {
  it('notes, without marking the Source unhealthy, that they need a dedicated bot instance while either is on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const on = open({ feishu: { directMessages: true, otherChats: 'none' } })
    const stop = new AbortController()
    let running = on.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    // The defaults have direct messages on: the note informs, and the Source stays healthy.
    expect(on.health.others).toMatchObject({ state: 'ready', code: 'feishuDedicatedBot' })
    expect(on.health.others?.detail).toContain('need a Feishu bot instance of Superagent')
    expect(
      sourcesStatus({ store: on.store, sources: on.sources, links: {} as never }, on.health, {}).find(
        (source) => source.id === 'feishu',
      )?.state,
    ).toBe('ready')
    stop.abort()
    await running
    const other = open({ feishu: { directMessages: false, otherChats: 'mentions' } })
    const ended = new AbortController()
    running = other.run(ended.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(other.health.others).toMatchObject({ state: 'ready', code: 'feishuDedicatedBot' })
    ended.abort()
    await running
    const off = open({ feishu: { directMessages: false, otherChats: 'none' } })
    const done = new AbortController()
    running = off.run(done.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(off.health.others).toMatchObject({ state: 'ready', detail: 'Only the listed chats are received' })
    done.abort()
    await running
  })
  it('notes in the admission table that direct messages and other chats are not received yet, rather than promising them', () => {
    const h = open()
    const rows = (config: Record<string, unknown>) =>
      Object.fromEntries(h.kind.policy!.rows!(config).map((row) => [row.id, row.note]))
    expect(rows({ directMessages: true, otherChats: 'mentions' })).toMatchObject({
      direct: { zh: '需要专用机器人，暂不接收', en: 'Needs a dedicated bot; not received yet' },
      other: { zh: '仅 @，需要专用机器人，暂不接收', en: '@ only; needs a dedicated bot; not received yet' },
    })
    expect(rows({ directMessages: false, otherChats: 'none' })).toMatchObject({
      direct: { zh: '不接收', en: 'Not received' },
      other: { zh: '不接收', en: 'Not received' },
    })
  })
})

describe('missing channel features', () => {
  it('runs live on a channel without reads and reports each missing feature on its health with what it means', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const fake = fakeChannels({
      reads: { messages: false, threads: false, history: false, chats: false, members: false },
    })
    const h = open({ fake })
    const stop = new AbortController()
    const running = h.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.health.feishu).toMatchObject({ state: 'ready' })
    expect(h.health.history).toMatchObject({ state: 'paused', code: 'feishuNoHistory' })
    expect(h.health.members).toMatchObject({ state: 'paused', code: 'feishuNoMembers' })
    expect(h.health.reads).toMatchObject({ state: 'paused', code: 'feishuNoReads' })
    expect(h.health.members?.detail).toContain('allowlist in the settings applies')
    expect(h.health.reads?.detail).toContain('orchestrator_feishu_read')
    // The probe reads nothing: every read was refused before it reached the channel.
    expect(
      fake
        .calls()
        .filter(
          (call) => /^(fetch|list)/.test(call.method) && call.args[0] !== '' && call.method !== 'listChats',
        ),
    ).toEqual([])
    expect(h.fake.emit(message('om_1', { mentioned: true }))).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.trigger('om_1')).toBeDefined()
    stop.abort()
    await running
  })
  it('reports every feature as there on a channel that reads everything', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    const h = open()
    const stop = new AbortController()
    const running = h.run(stop.signal)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.health.members).toMatchObject({ state: 'ready' })
    expect(h.health.reads).toMatchObject({ state: 'ready' })
    expect(h.health.history?.code).toBeUndefined()
    stop.abort()
    await running
  })
})
