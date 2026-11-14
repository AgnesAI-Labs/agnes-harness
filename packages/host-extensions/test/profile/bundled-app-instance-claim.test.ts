import type { ChannelEvent, MessageEvent } from '@agnes/extension-api/channel-contract'
import { describe, expect, it } from 'vitest'
import {
  BundledAppChannelHub,
  type BundledAppChannelLink,
  bundledAppChannels,
} from '../../src/profile/bundled-app-channels.js'

const ROW = '@sample/chat#plugin/aa'
const PLUGIN = 'ext:sample/chat/main'
const claimed = expect.objectContaining({ message: 'SEMANTIC_REJECTED', data: { code: 'CHANNEL_CLAIMED' } })
const unavailable = expect.objectContaining({
  message: 'SEMANTIC_REJECTED',
  data: { code: 'CHANNEL_UNAVAILABLE' },
})

function message(id: string, chat: { id: string; type: 'dm' | 'group' } = { id: 'group-a', type: 'group' }) {
  return {
    kind: 'message',
    eventId: `event-${id}`,
    messageId: id,
    accountId: 'account',
    text: `text ${id}`,
    attachments: [],
    at: '2026-11-14T00:00:00.000Z',
    chat,
    sender: { userId: 'user', raw: {} },
    mentions: { bot: false, replyToBot: false, quoteBot: false },
  } satisfies MessageEvent
}
const dm = (id: string) => message(id, { id: 'dm-1', type: 'dm' })

function link() {
  const state = { occupied: false }
  const value = {
    connected: () => true,
    capabilities: () => ({ edit: true, card: true, thread: true, attachment: false }),
    send: async (target: { chatId: string }) => ({ chatId: target.chatId, messageId: 'sent' }),
    reads: () => ({}),
    bound: () => false,
    occupied: () => state.occupied,
  } satisfies BundledAppChannelLink
  return { value, state }
}

/** A hub whose channel row (plugin `PLUGIN`) runs the instances `bot` and `team`. */
function running() {
  const hub = new BundledAppChannelHub()
  const port = hub.bridge(ROW, PLUGIN)
  const bot = link()
  const team = link()
  port.attach('bot', bot.value)
  port.attach('team', team.value)
  return { hub, port, bot, team }
}

describe('BundledAppChannels.claimInstance', () => {
  it('sends the group chats and direct messages of a claimed instance only to the claimant', () => {
    const { hub, port } = running()
    const received: ChannelEvent[] = []
    const claim = bundledAppChannels(hub, { assertCurrent() {} }).claimInstance(
      { pluginId: PLUGIN, instanceId: 'bot' },
      (event) => received.push(event),
    )
    expect(port.claimedInstance('bot')).toBe(true)
    expect(port.claimed('bot', 'group-a')).toBe(true)
    port.deliver('bot', message('g1'))
    port.deliver('bot', dm('d1'))
    // A click is never a session's, nor the claimant's: the claim takes messages only.
    port.deliver('bot', { ...dm('c1'), kind: 'cardAction', value: 'x' } as unknown as ChannelEvent)
    expect(received.map((event) => event.eventId)).toEqual(['event-g1', 'event-d1'])
    expect(received[1]).toMatchObject({ chat: { type: 'dm' } })
    // A platform redelivery of a recent event is dropped.
    port.deliver('bot', dm('d1'))
    expect(received).toHaveLength(2)
    claim.release()
  })

  it('refuses a second claimant of the instance and a group subscriber, with CHANNEL_CLAIMED', () => {
    const { hub } = running()
    const first = bundledAppChannels(hub, { assertCurrent() {} })
    const second = bundledAppChannels(hub, { assertCurrent() {} })
    const claim = first.claimInstance({ pluginId: PLUGIN, instanceId: 'bot' }, () => {})
    expect(() => second.claimInstance({ pluginId: PLUGIN, instanceId: 'bot' }, () => {})).toThrow(claimed)
    expect(() => second.subscribe('bot', ['group-a'], () => {})).toThrow(claimed)
    claim.release()
    claim.release()
    expect(() => second.subscribe('bot', ['group-a'], () => {})).not.toThrow()
  })

  it('refuses to claim an instance one of whose groups a bundled app subscribed', () => {
    const { hub } = running()
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    const stop = channels.subscribe('bot', ['group-a'], () => {})
    expect(() => channels.claimInstance({ pluginId: PLUGIN, instanceId: 'bot' }, () => {})).toThrow(claimed)
    stop()
    expect(() => channels.claimInstance({ pluginId: PLUGIN, instanceId: 'bot' }, () => {})).not.toThrow()
  })

  it('refuses an instance that already has an owner-paired direct chat or a bound session', () => {
    const { hub, port, bot } = running()
    bot.state.occupied = true
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    expect(() => channels.claimInstance({ pluginId: PLUGIN, instanceId: 'bot' }, () => {})).toThrow(claimed)
    expect(port.claimedInstance('bot')).toBe(false)
    bot.state.occupied = false
    expect(() => channels.claimInstance({ pluginId: PLUGIN, instanceId: 'bot' }, () => {})).not.toThrow()
  })

  it('refuses an instance that is not running, or not of the named plugin, with CHANNEL_UNAVAILABLE', () => {
    const { hub } = running()
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    expect(() => channels.claimInstance({ pluginId: PLUGIN, instanceId: 'absent' }, () => {})).toThrow(
      unavailable,
    )
    expect(() =>
      channels.claimInstance({ pluginId: 'ext:other/chat/main', instanceId: 'bot' }, () => {}),
    ).toThrow(unavailable)
    expect(() => channels.claimInstance({ pluginId: PLUGIN, instanceId: '' }, () => {})).toThrow(
      expect.objectContaining({ message: 'INVALID_PARAMS' }),
    )
  })

  it('returns the instance to ordinary routing on release, on abort and when the grant goes stale', () => {
    const { hub, port } = running()
    const released = bundledAppChannels(hub, { assertCurrent() {} }).claimInstance(
      { pluginId: PLUGIN, instanceId: 'bot' },
      () => {},
    )
    released.release()
    expect(port.claimedInstance('bot')).toBe(false)
    expect(port.claimed('bot', 'group-a')).toBe(false)

    const abort = new AbortController()
    bundledAppChannels(hub, { assertCurrent() {}, signal: abort.signal }).claimInstance(
      { pluginId: PLUGIN, instanceId: 'bot' },
      () => {},
    )
    expect(port.claimedInstance('bot')).toBe(true)
    abort.abort()
    expect(port.claimedInstance('bot')).toBe(false)

    let current = true
    const received: string[] = []
    const stale = bundledAppChannels(hub, {
      assertCurrent() {
        if (!current) throw new Error('stale generation')
      },
    })
    stale.claimInstance({ pluginId: PLUGIN, instanceId: 'bot' }, (event) => received.push(event.eventId))
    current = false
    expect(port.claimedInstance('bot')).toBe(false)
    port.deliver('bot', dm('d1'))
    expect(received).toEqual([])
    expect(() => stale.claimInstance({ pluginId: PLUGIN, instanceId: 'bot' }, () => {})).toThrow(
      expect.objectContaining({ message: 'CAPABILITY_DENIED' }),
    )
  })

  it('leaves another instance, and the same instance id on another channel row, alone', () => {
    const { hub, port } = running()
    const received: string[] = []
    bundledAppChannels(hub, { assertCurrent() {} }).claimInstance(
      { pluginId: PLUGIN, instanceId: 'bot' },
      (event) => received.push(event.eventId),
    )
    expect(port.claimedInstance('team')).toBe(false)
    expect(port.claimed('team', 'group-a')).toBe(false)
    port.deliver('team', dm('t1'))
    // Another channel row runs an instance that happens to be called `bot` too.
    const other = hub.bridge('@other/chat#plugin/zz', 'ext:other/chat/main')
    other.attach('bot', link().value)
    expect(other.claimedInstance('bot')).toBe(false)
    expect(other.claimed('bot', 'group-a')).toBe(false)
    other.deliver('bot', dm('forged'))
    expect(received).toEqual([])
    expect(() =>
      bundledAppChannels(hub, { assertCurrent() {} }).subscribe('team', ['group-a'], () => {}),
    ).not.toThrow()
    // Once two rows share the id, sends and reads cannot pick one, so neither can a new claim.
    expect(() =>
      bundledAppChannels(hub, { assertCurrent() {} }).claimInstance(
        { pluginId: 'ext:other/chat/main', instanceId: 'bot' },
        () => {},
      ),
    ).toThrow(unavailable)
  })
})
