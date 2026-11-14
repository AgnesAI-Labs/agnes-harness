// Adapted from dsh-superagent (MIT)
import type { MessageEvent } from '@agnes/extension-api/channel-contract'
import { expect, it } from 'vitest'
import { Commands } from '../src/infra/commands.js'
import { SettingsSchema } from '../src/policy.js'
import { admissionContext, threadWindow } from '../src/sources/admission-context.js'
import { feishuKindFor, messageTrigger } from '../src/sources/feishu.js'
import { feishuLink } from '../src/sources/feishu-io.js'
import type { ContextMessage } from '../src/sources/kind.js'
import { SourceRegistry } from '../src/sources/registry.js'
import { testDeployment } from './fixtures/deployment.js'
import { configOnly, fakeChannels, message as feishuMessage } from './sources/fake-channels.js'

const message = (index: number): ContextMessage => ({
  id: `om_${index}`,
  from: 'ou_user',
  at: String(index),
  text: `Message ${index}`,
})
it('returns the thread opening and trigger neighbors with exact internal and trailing gaps', () => {
  const result = threadWindow(
    Array.from({ length: 40 }, (_, i) => message(i)),
    'om_25',
  )
  expect(result.entries.map((item: { position: number }) => item.position)).toEqual([
    1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  ])
  expect(result.entries[5]?.omitted_before).toBe(15)
  expect(result.omitted_after).toBe(9)
  expect(result.source_found).toBe(true)
})
it('deduplicates overlapping windows and reports an absent source without inventing neighbors', () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(i))
  expect(threadWindow(messages, 'om_3').entries.map((item: { position: number }) => item.position)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ])
  expect(threadWindow(messages, 'om_absent')).toMatchObject({
    source_found: false,
    loaded_messages: 12,
    omitted_after: 7,
  })
})
/** The Feishu kind on fake channels holding `history`, registered with its context reading `readPageSize`. */
function registered(history: MessageEvent[], readPageSize = 20) {
  const fake = fakeChannels({ history })
  const link = feishuLink(fake.channels)
  link.context = configOnly({ readPageSize })
  const sources = new SourceRegistry(() =>
    SettingsSchema.parse({
      sources: { feishu: { enabled: true, config: { channel: 'feishu', readPageSize } } },
    }),
  )
  sources.register(feishuKindFor(link))
  return { fake, sources }
}
const commands = () => new Commands(() => testDeployment(), {}, new AbortController().signal)
it('retains pagination limits and exact loaded counts rather than claiming complete history', async () => {
  const at = (n: number) => new Date(Date.parse('2026-11-14T08:00:00.000Z') + n * 1000).toISOString()
  const { fake, sources } = registered(
    [0, 1, 2].map((n) => feishuMessage(`om_${n}`, { chat: 'oc_chat', at: at(n), thread: 'omt_thread' })),
    2,
  )
  const trigger = messageTrigger(
    feishuMessage('om_9', { chat: 'oc_chat', at: at(9), thread: 'omt_thread' }),
    'om_0',
  )!
  const result = await admissionContext(sources.threadContext(trigger)!, commands(), 1)
  expect(result).toMatchObject({
    complete: false,
    next: '2',
    window: { loaded_messages: 2, source_found: false },
  })
  expect(fake.calls('listThread').map((call) => call.args)).toEqual([
    ['oc_chat', 'omt_thread', { order: 'asc', limit: 3 }],
  ])
})
it('gives a message outside a topic the five chat messages before it, and says it read the chat', async () => {
  const at = Date.parse('2026-09-11T12:00:00Z')
  const { fake, sources } = registered(
    [0, -1, -2, -3, -4, -5, -6].map((n) =>
      feishuMessage(`om_${n}`, { chat: 'oc_chat', at: at + n * 1000, text: `message ${n}` }),
    ),
  )
  const trigger = messageTrigger(feishuMessage('om_0', { chat: 'oc_chat', at, text: 'message 0' }), 'om_0')!
  const result = await admissionContext(sources.threadContext(trigger)!, commands(), 3)
  expect(result).toMatchObject({
    status: 'chat_neighbours',
    complete: true,
    window: { source_found: true, loaded_messages: 6 },
  })
  expect(result.messages.map((item) => item.id)).toEqual([-5, -4, -3, -2, -1, 0].map((n) => `om_${n}`))
  expect(fake.calls('listHistory')).toHaveLength(1)
})
