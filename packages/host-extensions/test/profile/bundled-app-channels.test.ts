import type { ChannelEvent, MessageEvent } from '@agnes/extension-api/channel-contract'
import { describe, expect, it, vi } from 'vitest'
import {
  BundledAppChannelHub,
  type BundledAppChannelLink,
  bundledAppChannels,
} from '../../src/profile/bundled-app-channels.js'

const CHANNEL_ROW = '@sample/chat#plugin/aa'
const denied = { message: 'CAPABILITY_DENIED' }

function message(id: string, chatId = 'group-a'): MessageEvent {
  return {
    kind: 'message',
    eventId: `event-${id}`,
    messageId: id,
    accountId: 'account',
    text: `text ${id}`,
    attachments: [],
    at: '2026-11-14T00:00:00.000Z',
    chat: { id: chatId, type: 'group' },
    sender: { userId: 'user', raw: {} },
    mentions: { bot: false, replyToBot: false, quoteBot: false },
  }
}

/** Pages of `size` over `items`, with an opaque cursor that names the next offset. */
function paged<T>(items: T[], size: number) {
  return (cursor?: string) => {
    const start = cursor ? Number(cursor.slice(1)) : 0
    const next = start + size
    return { page: items.slice(start, next), ...(next < items.length ? { cursor: `c${next}` } : {}) }
  }
}

function link(capabilities: ReturnType<typeof caps> = caps()) {
  const events = Array.from({ length: 7 }, (_, index) => message(`m${index + 1}`))
  const members = Array.from({ length: 5 }, (_, index) => ({ userId: `u${index + 1}` }))
  const chats = [{ id: 'group-a', name: 'A' }, { id: 'group-b' }, { id: 'group-c' }]
  const sends: unknown[] = []
  const bound = new Set<string>()
  const reads = {
    fetchMessages: vi.fn(async (_chat: string, ids: readonly string[]) =>
      events.filter((event) => ids.includes(event.messageId)),
    ),
    listThread: vi.fn(async (_chat: string, _thread: string, opts: { cursor?: string; pageSize: number }) => {
      const { page, cursor } = paged(events, opts.pageSize)(opts.cursor)
      return { events: page, ...(cursor ? { cursor } : {}) }
    }),
    listHistory: vi.fn(async (_chat: string, opts: { cursor?: string }) => {
      const { page, cursor } = paged(events, 3)(opts.cursor)
      return { events: page, ...(cursor ? { cursor } : {}) }
    }),
    listChats: vi.fn(async (opts: { cursor?: string }) => {
      const { page, cursor } = paged(chats, 2)(opts.cursor)
      return { chats: page, ...(cursor ? { cursor } : {}) }
    }),
    listMembers: vi.fn(async (_chat: string, opts: { cursor?: string }) => {
      const { page, cursor } = paged(members, 2)(opts.cursor)
      return { members: page, ...(cursor ? { cursor } : {}) }
    }),
  }
  const value = {
    connected: () => true,
    capabilities: () => capabilities,
    send: vi.fn(async (target: { chatId: string }, msg: unknown) => {
      sends.push([target, msg])
      return { chatId: target.chatId, messageId: `sent-${sends.length}` }
    }),
    reads: () => reads,
    bound: (chatId: string) => bound.has(chatId),
  } satisfies BundledAppChannelLink
  return { value, reads, sends, bound }
}

/** A hub whose channel row runs the instance `team`. */
function running() {
  const hub = new BundledAppChannelHub()
  const port = hub.bridge(CHANNEL_ROW)
  const team = link(caps(ALL_READS))
  port.attach('team', team.value)
  return { hub, port, team }
}

const ALL_READS = { messages: true, threads: true, history: true, chats: true, members: true }
const caps = (read?: Partial<typeof ALL_READS>) => ({
  edit: true,
  card: true,
  thread: true,
  attachment: false,
  ...(read ? { read } : {}),
})
const window = { start: '2026-11-14T00:00:00.000Z', end: '2026-11-14T00:01:00.000Z' }

function reads(channels: ReturnType<typeof bundledAppChannels>) {
  return [
    channels.fetchMessages('team', 'group-a', ['m1']),
    channels.listThread('team', 'group-a', 'thread-1', { order: 'asc', limit: 10 }),
    channels.listHistory('team', 'group-a', window),
    channels.listChats('team'),
    channels.listMembers('team', 'group-a'),
  ]
}

describe('BundledAppChannels reads', () => {
  it('refuses every read the adapter has not declared with CAPABILITY_DENIED', async () => {
    const hub = new BundledAppChannelHub()
    const undeclared = link(caps())
    const detach = hub.bridge(CHANNEL_ROW).attach('team', undeclared.value)
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    for (const read of reads(channels)) await expect(read).rejects.toMatchObject(denied)
    for (const method of ['fetchMessages', 'listThread', 'listHistory', 'listChats', 'listMembers'] as const)
      expect(undeclared.reads[method]).not.toHaveBeenCalled()
    detach()
    // Declared but not implemented is refused the same way.
    hub.bridge(CHANNEL_ROW).attach('team', { ...link(caps(ALL_READS)).value, reads: () => ({}) })
    for (const read of reads(channels)) await expect(read).rejects.toMatchObject(denied)
  })

  it('aggregates the adapter cursor pages into one array', async () => {
    const hub = new BundledAppChannelHub()
    const declared = link(caps(ALL_READS))
    hub.bridge(CHANNEL_ROW).attach('team', declared.value)
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    const ids = (events: MessageEvent[]) => events.map((event) => event.messageId)
    expect(ids(await channels.listHistory('team', 'group-a', window))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
      'm7',
    ])
    expect(declared.reads.listHistory).toHaveBeenCalledTimes(3)
    expect(declared.reads.listHistory).toHaveBeenLastCalledWith('group-a', { ...window, cursor: 'c6' })
    expect(
      ids(await channels.listThread('team', 'group-a', 'thread-1', { order: 'desc', limit: 5 })),
    ).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(declared.reads.listThread).toHaveBeenLastCalledWith('group-a', 'thread-1', {
      order: 'desc',
      pageSize: 5,
    })
    expect(await channels.listChats('team')).toEqual([
      { id: 'group-a', name: 'A' },
      { id: 'group-b' },
      { id: 'group-c' },
    ])
    expect((await channels.listMembers('team', 'group-a')).map((member) => member.userId)).toEqual([
      'u1',
      'u2',
      'u3',
      'u4',
      'u5',
    ])
    expect(ids(await channels.fetchMessages('team', 'group-a', ['m2', 'm4']))).toEqual(['m2', 'm4'])
  })

  it('refuses a cursor that does not advance instead of looping', async () => {
    const hub = new BundledAppChannelHub()
    const stuck = link(caps(ALL_READS))
    stuck.reads.listChats.mockImplementation(async () => ({ chats: [{ id: 'group-a' }], cursor: 'same' }))
    hub.bridge(CHANNEL_ROW).attach('team', stuck.value)
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    await expect(channels.listChats('team')).rejects.toMatchObject({ message: 'SEMANTIC_REJECTED' })
    expect(stuck.reads.listChats).toHaveBeenCalledTimes(2)
  })

  it('names a channel by its instance id and refuses one that is not running', async () => {
    const hub = new BundledAppChannelHub()
    const team = link()
    hub.bridge(CHANNEL_ROW).attach('team', team.value)
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    const ref = await channels.send(
      'team',
      { chatId: 'group-a' },
      { blocks: [{ kind: 'text', markdown: 'hi' }] },
    )
    expect(ref).toEqual({ chatId: 'group-a', messageId: 'sent-1' })
    await expect(
      channels.send('other', { chatId: 'group-a' }, { blocks: [{ kind: 'text', markdown: 'hi' }] }),
    ).rejects.toMatchObject({ message: 'SEMANTIC_REJECTED', data: { code: 'CHANNEL_UNAVAILABLE' } })
  })
})

describe('BundledAppChannels subscriptions', () => {
  it('delivers a claimed group to its subscriber and refuses a second claim until the first ends', () => {
    const { hub, port } = running()
    const first = bundledAppChannels(hub, { assertCurrent() {} })
    const second = bundledAppChannels(hub, { assertCurrent() {} })
    const received: ChannelEvent[] = []
    const stop = first.subscribe('team', ['group-a', 'group-b'], (event) => received.push(event))
    expect(port.claimed('team', 'group-a')).toBe(true)
    expect(port.claimed('team', 'group-c')).toBe(false)
    expect(port.claimed('other', 'group-a')).toBe(false)
    expect(() => second.subscribe('team', ['group-c', 'group-b'], () => {})).toThrow(
      expect.objectContaining({ message: 'SEMANTIC_REJECTED', data: { code: 'CHANNEL_CHAT_CLAIMED' } }),
    )
    // The refused call claimed nothing, not even its free chat.
    expect(port.claimed('team', 'group-c')).toBe(false)
    const event = message('m1')
    port.deliver('team', event)
    expect(received).toEqual([event])
    expect(received[0]).not.toBe(event)
    stop()
    stop()
    expect(port.claimed('team', 'group-a')).toBe(false)
    expect(() => second.subscribe('team', ['group-b'], () => {})).not.toThrow()
  })

  it('keeps a failing subscriber from breaking the channel', () => {
    const { hub, port } = running()
    bundledAppChannels(hub, { assertCurrent() {} }).subscribe('team', ['group-a'], () => {
      throw new Error('subscriber failed')
    })
    expect(() => port.deliver('team', message('m1'))).not.toThrow()
  })

  it('ends a subscription with its generation and refuses the stale grant', async () => {
    const { hub, port } = running()
    let current = true
    const stale = bundledAppChannels(hub, {
      assertCurrent() {
        if (!current) throw new Error('stale generation')
      },
    })
    const received: ChannelEvent[] = []
    stale.subscribe('team', ['group-a'], (event) => received.push(event))
    expect(port.claimed('team', 'group-a')).toBe(true)
    current = false
    // The group falls back to the ordinary path and the next generation may claim it.
    expect(port.claimed('team', 'group-a')).toBe(false)
    port.deliver('team', message('m1'))
    expect(received).toEqual([])
    expect(() => stale.subscribe('team', ['group-b'], () => {})).toThrow(expect.objectContaining(denied))
    await expect(stale.listChats('team')).rejects.toMatchObject(denied)
    const next = bundledAppChannels(hub, { assertCurrent() {} })
    expect(() => next.subscribe('team', ['group-a'], () => {})).not.toThrow()
  })

  it('releases the claims of a grant whose signal aborts', () => {
    const { hub, port } = running()
    const abort = new AbortController()
    bundledAppChannels(hub, { assertCurrent() {}, signal: abort.signal }).subscribe(
      'team',
      ['group-a'],
      () => {},
    )
    expect(port.claimed('team', 'group-a')).toBe(true)
    abort.abort()
    expect(port.claimed('team', 'group-a')).toBe(false)
  })

  it('refuses a group a session is bound to, and a channel that is not running', () => {
    const { hub, port, team } = running()
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    team.bound.add('group-b')
    expect(() => channels.subscribe('team', ['group-a', 'group-b'], () => {})).toThrow(
      expect.objectContaining({ message: 'SEMANTIC_REJECTED', data: { code: 'CHANNEL_CHAT_CLAIMED' } }),
    )
    expect(port.claimed('team', 'group-a')).toBe(false)
    // The owner unbinds the session first; then the group can be claimed.
    team.bound.delete('group-b')
    expect(() => channels.subscribe('team', ['group-a', 'group-b'], () => {})).not.toThrow()
    expect(() => channels.subscribe('other', ['group-a'], () => {})).toThrow(
      expect.objectContaining({ data: { code: 'CHANNEL_UNAVAILABLE' } }),
    )
  })

  it('drops a redelivered event within the live subscription', () => {
    const { hub, port } = running()
    const channels = bundledAppChannels(hub, { assertCurrent() {} })
    const received: string[] = []
    const stop = channels.subscribe('team', ['group-a'], (event) => received.push(event.eventId))
    port.deliver('team', message('m1'))
    port.deliver('team', message('m1'))
    port.deliver('team', { ...message('m1'), accountId: 'other-account' })
    expect(received).toEqual(['event-m1', 'event-m1'])
    // The window is bounded: an event redelivered after 1024 newer ones arrives again.
    for (let index = 0; index < 1024; index++) port.deliver('team', message(`n${index}`))
    received.length = 0
    port.deliver('team', message('m1'))
    expect(received).toEqual(['event-m1'])
    // A new subscription starts with no memory of the old one.
    stop()
    channels.subscribe('team', ['group-a'], (event) => received.push(event.eventId))
    port.deliver('team', message('n1023'))
    expect(received).toEqual(['event-m1', 'event-n1023'])
  })
})
