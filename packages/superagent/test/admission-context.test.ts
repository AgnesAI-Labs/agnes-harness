// Adapted from dsh-superagent (MIT)
import { expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.js'
import { Commands } from '../src/infra/commands.js'
import { SettingsSchema } from '../src/policy.js'
import { admissionContext, threadWindow } from '../src/sources/admission-context.js'
import { feishuKind } from '../src/sources/feishu.js'
import type { ContextMessage } from '../src/sources/kind.js'
import { SourceRegistry } from '../src/sources/registry.js'
import { testDeployment } from './fixtures/deployment.js'

const message = (index: number): ContextMessage => ({
  id: `om_${index}`,
  from: 'ou_user',
  at: String(index),
  text: `Message ${index}`,
})
/** The same message as a Feishu topic page lists it. */
const listed = (index: number) => ({
  message_id: `om_${index}`,
  chat_id: 'oc_chat',
  content: `Message ${index}`,
  msg_type: 'text',
  sender: { id: 'ou_user', sender_type: 'user' },
  create_time: String(index),
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
it.todo('retains pagination limits and exact loaded counts rather than claiming complete history')
it.todo('gives a message outside a topic the five chat messages before it, and says it read the chat')
