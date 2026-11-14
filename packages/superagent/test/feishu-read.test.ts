// Adapted from dsh-superagent (MIT)
/** Reading Feishu messages, topics and chat history through the AGH channel (source `sources/feishu-read.ts`). */
import { describe, expect, it } from 'vitest'
import { sourceLink } from '../src/app/links.js'
import type { Trigger } from '../src/core/index.js'
import { feishuKindFor, messageTrigger } from '../src/sources/feishu.js'
import { feishuLink, linkIo } from '../src/sources/feishu-io.js'
import { feishuRead, feishuReferences, feishuView } from '../src/sources/feishu-read.js'
import { fakeChannels, message, rpc } from './sources/fake-channels.js'

const at = (seconds: number) =>
  new Date(Date.parse('2026-11-14T08:00:00.000Z') + seconds * 1000).toISOString()
const source = (fields: Parameters<typeof message>[1] = {}, root = 'om_src') =>
  messageTrigger(message('om_src', { at: at(0), ...fields }), root)!
const ref = (trigger: Trigger) => {
  const meta = trigger.meta as Record<string, string>
  return {
    triggerId: trigger.id,
    chatId: meta.chatId!,
    messageId: meta.messageId!,
    at: trigger.at,
    ...(meta.rootId ? { rootId: meta.rootId } : {}),
    ...(meta.parentId ? { parentId: meta.parentId } : {}),
    ...(meta.threadId ? { threadId: meta.threadId } : {}),
  }
}
const reader = (fake: ReturnType<typeof fakeChannels>) => linkIo(feishuLink(fake.channels), 'feishu')

describe('feishu-read', () => {
  it('reads the source message, the first message of its topic and the message it quotes, by id in its chat', async () => {
    const fake = fakeChannels({
      history: [
        message('om_src', { at: at(0), thread: 'omt_1', quoted: 'om_parent' }),
        message('om_root', { at: at(-60), thread: 'omt_1', text: 'the request' }),
        message('om_parent', { at: at(-30), thread: 'omt_1', text: 'the quoted one' }),
      ],
    })
    const trigger = source({ thread: 'omt_1', quoted: 'om_parent' }, 'om_root')
    const read = (section: string) =>
      feishuRead(reader(fake), ref(trigger), `feishu/${trigger.id}/${section}`, 20)
    expect(await read('message')).toMatchObject({ status: 'available', message: { id: 'om_src' } })
    expect(await read('root')).toMatchObject({
      status: 'available',
      message: { id: 'om_root', text: 'the request' },
    })
    expect(await read('parent')).toMatchObject({ message: { id: 'om_parent', text: 'the quoted one' } })
    expect(fake.calls('fetchMessages').map((call) => call.args)).toEqual([
      ['oc_team', ['om_src']],
      ['oc_team', ['om_root']],
      ['oc_team', ['om_parent']],
    ])
    expect(feishuReferences(ref(trigger))).toMatchObject({
      skill: 'dsh-superagent-feishu',
      thread: `feishu/${trigger.id}/thread`,
    })
  })
  it('pages a topic with next_resource cursors and keeps each author', async () => {
    const topic = [0, 1, 2, 3, 4].map((n) =>
      message(`om_${n}`, {
        at: at(n),
        thread: 'omt_1',
        sender: `ou_${n}`,
        ...(n % 2 ? { name: `User ${n}` } : {}),
      }),
    )
    const fake = fakeChannels({ history: topic })
    const trigger = source({ thread: 'omt_1' }, 'om_0')
    const first = await feishuRead(reader(fake), ref(trigger), `feishu/${trigger.id}/thread`, 2)
    expect(first).toMatchObject({
      status: 'available',
      thread_id: 'omt_1',
      next_resource: `feishu/${trigger.id}/thread/2`,
    })
    expect('messages' in first && first.messages.map((item) => [item.id, item.from])).toEqual([
      ['om_0', 'ou_0'],
      ['om_1', 'User 1'],
    ])
    const last = await feishuRead(reader(fake), ref(trigger), `feishu/${trigger.id}/thread/4`, 2)
    expect(last).toMatchObject({ next_resource: null })
    expect('messages' in last && last.messages.map((item) => item.id)).toEqual(['om_4'])
  })
  it('refuses a topic page that holds a message of another topic, and reads the topic the channel checked', async () => {
    const fake = fakeChannels({ history: [message('om_0', { thread: 'omt_1' })] })
    const trigger = source({ thread: 'omt_1' }, 'om_0')
    expect(await feishuRead(reader(fake), ref(trigger), `feishu/${trigger.id}/thread`, 20)).toMatchObject({
      messages: [{ id: 'om_0' }],
    })
    fake.channels.listThread = async () => [message('om_9', { thread: 'omt_2' })]
    await expect(feishuRead(reader(fake), ref(trigger), `feishu/${trigger.id}/thread`, 20)).rejects.toThrow(
      'outside the source thread',
    )
  })
  it('rejects unrelated paths, other triggers, cross-chat results, and a cursor the channel says stalled', async () => {
    const fake = fakeChannels({ history: [message('om_src', { thread: 'omt_1' })] })
    const trigger = source({ thread: 'omt_1' })
    const read = (resource: string) => feishuRead(reader(fake), ref(trigger), resource, 20)
    await expect(read('feishu/x/../../etc')).rejects.toThrow('Use feishu/<trigger-id>/message')
    await expect(read(`feishu/${trigger.id}/message/cursor`)).rejects.toThrow('Use feishu/')
    await expect(read('feishu/other/message')).rejects.toThrow('A Feishu source trigger is required')
    fake.channels.fetchMessages = async () => [message('om_src', { chat: 'oc_other' })]
    await expect(read(`feishu/${trigger.id}/message`)).rejects.toThrow('outside the requested chat')
    fake.channels.listThread = async () => {
      throw rpc('SEMANTIC_REJECTED', 'CHANNEL_CURSOR_STALLED')
    }
    await expect(read(`feishu/${trigger.id}/thread`)).rejects.toMatchObject({
      data: { code: 'CHANNEL_CURSOR_STALLED' },
    })
  })
  it('reports an absent root, parent or topic, and a message the channel no longer has, explicitly', async () => {
    const fake = fakeChannels()
    const trigger = source()
    const read = (section: string) =>
      feishuRead(reader(fake), ref(trigger), `feishu/${trigger.id}/${section}`, 20)
    expect(await read('root')).toEqual({ status: 'no_root', message: null })
    expect(await read('parent')).toEqual({ status: 'no_parent', message: null })
    expect(await read('thread')).toEqual({ status: 'no_thread', messages: [], next_resource: null })
    await expect(read('message')).rejects.toThrow('unavailable; do not infer its contents')
  })
  it('refers to a Feishu message, which comes without a link, by the resource that reads it', async () => {
    const trigger = source()
    expect(await sourceLink({} as never, trigger)).toEqual({
      source_url_read: `feishu/${trigger.id}/message`,
    })
    expect(await sourceLink({} as never, { ...trigger, url: 'https://x/y' })).toEqual({
      source_url: 'https://x/y',
    })
  })
  it('reads a topic page as messages a model reads: id, author, ISO time, text and the message each answers', () => {
    expect(
      feishuView(
        message('om_2', { at: at(5), sender: 'ou_bob', name: 'Bob', text: 'yes', quoted: 'om_1', bot: true }),
      ),
    ).toEqual({ id: 'om_2', from: 'Bob', at: at(5), text: 'yes', bot: true, reply_to: 'om_1' })
    expect(feishuView(message('om_3', { at: at(6), sender: 'ou_carol' }))).toEqual({
      id: 'om_3',
      from: 'ou_carol',
      at: at(6),
      text: 'text of om_3',
    })
  })
  it('reads the chat around a message by time: five before it, the message and five after, then earlier pages', async () => {
    const chat = Array.from({ length: 30 }, (_, i) => message(`om_${i - 20}`, { at: at((i - 20) * 60) }))
    const fake = fakeChannels({ history: chat })
    const trigger = messageTrigger(message('om_0', { at: at(0) }), 'om_0')!
    const first = await feishuRead(reader(fake), ref(trigger), `feishu/${trigger.id}/around`, 20)
    expect('messages' in first && first.messages.map((item) => item.id)).toEqual(
      [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((n) => `om_${n}`),
    )
    expect(fake.calls('listHistory').map((call) => call.args[1])).toEqual([
      { start: at(-3600), end: at(3600) },
    ])
    const next = 'next_resource' in first ? first.next_resource! : ''
    expect(next).toBe(`feishu/${trigger.id}/around/${encodeURIComponent(at(-300))}`)
    const older = await feishuRead(reader(fake), ref(trigger), next, 20)
    expect('messages' in older && older.messages.map((item) => item.id)).toEqual(
      [-15, -14, -13, -12, -11, -10, -9, -8, -7, -6].map((n) => `om_${n}`),
    )
  })
  it('says the channel does not support reading when it declares no read, through the kind as well', async () => {
    const fake = fakeChannels({ reads: { messages: false, threads: false, history: false } })
    const trigger = source({ thread: 'omt_1' })
    await expect(feishuRead(reader(fake), ref(trigger), `feishu/${trigger.id}/message`, 20)).rejects.toThrow(
      'The Feishu channel does not support reading messages by id',
    )
    const link = feishuLink(fake.channels)
    link.context = { config: () => ({ channel: 'feishu' }) } as never
    const context = feishuKindFor(link).threadContext!
    await expect(
      context.read({} as never, trigger, 'thread', undefined, { readPageSize: 20 } as never),
    ).rejects.toThrow('does not support reading threads')
    expect([...link.missing]).toEqual(['threads'])
  })
})
