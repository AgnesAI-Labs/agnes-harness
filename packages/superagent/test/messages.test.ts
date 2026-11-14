/** How a worker session is named and how a trigger or an input is put to it. */
import { expect, it } from 'vitest'
import { AcknowledgementSchema } from '../src/app/acknowledgement.js'
import {
  batchLine,
  capped,
  inputResource,
  ticketOfSessionKey,
  triggerMessage,
  workerSessionKey,
} from '../src/app/messages.js'
import type { Trigger } from '../src/core/index.js'
import { IM_WORDS } from '../src/infra/text.js'

const trigger = (id: string, text: string): Trigger => ({
  id,
  source: 'github',
  threads: [{ source: 'github', id: '7' }],
  actor: { source: 'github', id: 'alice' },
  human: true,
  at: '2026-11-01T00:00:00.000Z',
  text,
  meta: {},
})

it("names a ticket's worker session by its key, and reads the ticket back from that key alone", () => {
  expect(workerSessionKey('t1')).toBe('superagent:worker:t1')
  expect(ticketOfSessionKey('superagent:worker:t1')).toBe('t1')
  expect(ticketOfSessionKey('superagent:orchestrator')).toBeUndefined()
  expect(ticketOfSessionKey('worker-t1')).toBeUndefined()
})

it('puts a trigger to a worker whole when it is short and by a preview and its resource when it is long', () => {
  expect(capped('abc', 3, 'r')).toEqual({ text: 'abc' })
  expect(capped('abcd', 3, 'r')).toEqual({ text: 'abc…', chars: 4, read: 'r' })
  expect(triggerMessage(trigger('g1', 'short'), {})).toEqual({
    trigger_id: 'g1',
    from: 'alice',
    thread: 'github:7',
    at: '2026-11-01T00:00:00.000Z',
    text: 'short',
  })
  const long = triggerMessage(
    trigger('g2', 'y'.repeat(601)),
    { source_url: 'u' },
    'a note',
    trigger('g1', 'the\n  parent'),
  )
  expect(long).toMatchObject({
    text: `${'y'.repeat(600)}…`,
    chars: 601,
    read: 'trigger/g2',
    source_url: 'u',
    routing_note: 'a note',
    replies_to: { trigger_id: 'g1', preview: 'the parent' },
  })
  expect(batchLine(trigger('g3', 'two\nlines'))).toMatchObject({
    trigger_id: 'g3',
    preview: 'two lines',
    read: 'trigger/g3',
  })
})

it('names the resource of an input by a key safe for a path', () => {
  expect(inputResource('t1', 'a/b c')).toMatch(/^ticket\/t1\/input\/[^/ ]+$/)
  expect(inputResource('t1', 'a')).toBe(inputResource('t1', 'a'))
  expect(inputResource('t1', 'a')).not.toBe(inputResource('t1', 'b'))
})

it('accepts a short acknowledgement, trimmed, and refuses an empty one or one over the word limit', () => {
  expect(AcknowledgementSchema.parse('  Got it, fixing the copy.  ')).toBe('Got it, fixing the copy.')
  expect(AcknowledgementSchema.safeParse('   ').success).toBe(false)
  expect(
    AcknowledgementSchema.safeParse(Array.from({ length: IM_WORDS + 1 }, () => 'word').join(' ')).success,
  ).toBe(false)
})
