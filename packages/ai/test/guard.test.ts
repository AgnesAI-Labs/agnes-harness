import { AI_ERROR_CODES, type InferenceEvent } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { guardSequence, normalizeError, RETRYABLE, retryHint } from '../src/index.js'
import { fakeRequest, stampFor } from '../testkit/index.js'

const sent: InferenceEvent = { type: 'sent', stamp: stampFor(fakeRequest()) }
const usage: InferenceEvent = {
  type: 'usage',
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  creditSource: 'estimated',
}
const done: InferenceEvent = { type: 'done', reason: 'stop' }
const delta: InferenceEvent = { type: 'text_delta', delta: 'x' }

async function* src(events: InferenceEvent[], throwAt?: number) {
  let i = 0
  for (const e of events) {
    if (throwAt === i++) throw new Error('boom')
    yield e
  }
}
async function collect(it: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const out: InferenceEvent[] = []
  for await (const e of it) out.push(e)
  return out
}
const types = (es: InferenceEvent[]) => es.map((e) => e.type)

describe('guardSequence', () => {
  it('passes a legal stream through', async () => {
    expect(types(await collect(guardSequence(src([sent, delta, usage, done]))))).toEqual([
      'sent',
      'text_delta',
      'usage',
      'done',
    ])
  })

  it('rejects a stream that started answering without saying what it sent', async () => {
    const o = await collect(guardSequence(src([delta, usage, done])))
    expect(o).toHaveLength(1)
    expect(o[0]).toMatchObject({ type: 'error', code: 'TRANSPORT', message: 'missing sent' })
  })

  // These three are legal first events: nothing was sent because nothing could be. Rewriting one as
  // a retryable transport failure would have the caller wait and try again against a route that has
  // no adapter or no credential - a misconfiguration retried as if it were a blip, until the budget
  // is gone.
  it.each(['NO_MODEL', 'NO_ADAPTER', 'AUTH'] as const)(
    'passes a terminal-first %s through unchanged',
    async (code) => {
      const e: InferenceEvent = { type: 'error', reason: 'error', code, message: 'route=x', retryable: false }
      const o = await collect(guardSequence(src([e])))
      expect(o).toHaveLength(1)
      expect(o[0]).toMatchObject({ type: 'error', code, retryable: false })
    },
  )

  // And it holds the other way too: a terminal-first error that arrived claiming to be retryable is
  // clamped by the table rather than believed.
  it('clamps a terminal-first error that claimed to be retryable', async () => {
    const e: InferenceEvent = { type: 'error', reason: 'error', code: 'AUTH', message: 'x', retryable: true }
    expect((await collect(guardSequence(src([e]))))[0]).toMatchObject({ code: 'AUTH', retryable: false })
  })

  it('rewrites a done that never accounted for itself', async () => {
    const o = await collect(guardSequence(src([sent, delta, done])))
    expect(types(o)).toEqual(['sent', 'text_delta', 'error'])
    expect(o[2]).toMatchObject({ message: 'done without usage' })
  })

  it('drops events after usage and ends with an error', async () => {
    expect(types(await collect(guardSequence(src([sent, usage, delta, done]))))).toEqual([
      'sent',
      'usage',
      'error',
    ])
  })

  it('rejects a second sent', async () => {
    const o = await collect(guardSequence(src([sent, sent, usage, done])))
    expect(types(o)).toEqual(['sent', 'error'])
    expect(o[1]).toMatchObject({ message: 'duplicate sent' })
  })

  it('drops anything after a terminal event', async () => {
    expect(types(await collect(guardSequence(src([sent, usage, done, delta, done]))))).toEqual([
      'sent',
      'usage',
      'done',
    ])
  })

  it('converts a throwing source into an in-stream error', async () => {
    expect(types(await collect(guardSequence(src([sent, delta, usage, done], 2))))).toEqual([
      'sent',
      'text_delta',
      'error',
    ])
  })

  it('closes a source that simply stopped', async () => {
    const o = await collect(guardSequence(src([sent, delta])))
    expect(types(o)).toEqual(['sent', 'text_delta', 'error'])
    expect(o[2]).toMatchObject({ message: 'stream ended without terminal event' })
  })
})

describe('normalizeError', () => {
  it('clamps retryability, forces the abort reason and bounds the message', () => {
    const e = normalizeError({
      type: 'error',
      reason: 'error',
      code: 'AUTH',
      message: 'x'.repeat(600),
      retryable: true,
      retryAfterMs: 5,
    })
    expect(e.retryable).toBe(false)
    // A wait attached to a failure nobody may retry is a number that can only be acted on wrongly.
    expect(e.retryAfterMs).toBeUndefined()
    expect(e.message).toHaveLength(512)
    expect(
      normalizeError({ type: 'error', reason: 'error', code: 'ABORTED', message: '', retryable: false })
        .reason,
    ).toBe('aborted')
    expect(RETRYABLE.RATE_LIMIT).toBe(true)
  })

  // TRANSPORT is the one code the table does not decide: whether a transport failure may be repeated
  // depends on which one it was, and the adapter is the only layer that knows.
  it('leaves the adapter’s own verdict on TRANSPORT alone, both ways', () => {
    for (const retryable of [true, false])
      expect(
        normalizeError({ type: 'error', reason: 'error', code: 'TRANSPORT', message: '', retryable })
          .retryable,
      ).toBe(retryable)
  })

  it('keeps the wait and the request id on a failure that may be retried', () => {
    const e = normalizeError({
      type: 'error',
      reason: 'error',
      code: 'RATE_LIMIT',
      message: 'slow down',
      retryable: true,
      retryAfterMs: 7000,
      requestId: 'req_1',
    })
    expect(e).toMatchObject({ retryAfterMs: 7000, requestId: 'req_1', retryable: true })
  })
})

describe('retryHint', () => {
  // The whole table, all eleven codes. This is the map the caller reads to decide whether to retry
  // and how long to wait; two spot checks out of eleven left nine rows proved by nothing.
  it.each([
    ['AUTH', false, 0],
    ['RATE_LIMIT', true, 1000],
    ['QUOTA', false, 0],
    ['OVERFLOW', false, 0],
    ['TIMEOUT', true, 2000],
    ['NO_MODEL', false, 0],
    ['NO_ADAPTER', false, 0],
    ['FORMAT', false, 0],
    ['TRANSPORT', true, 500],
    ['CONTRACT_MISMATCH', false, 0],
    ['ABORTED', false, 0],
  ] as const)('retryHint(%s)', (code, retryable, backoffMs) => {
    expect(retryHint(code)).toEqual({ retryable, backoffMs })
  })

  // The list above is written out, so it has to be held to protocol's own closed set: a code added
  // there and not here would otherwise reach retryHint and read as `undefined`, which is neither
  // retryable nor not.
  it('covers every code protocol declares, and no others', () => {
    expect(Object.keys(RETRYABLE).sort()).toEqual([...AI_ERROR_CODES].sort())
  })
})
