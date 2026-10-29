import { describe, expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { ProtocolViolation } from '../src/errors.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint, type Handler } from './helpers/fake-endpoint.js'

const providers = { local: () => localAuth() }
const init: Handler = fakeEndpoint({}).initialize

function harness(read: Handler) {
  const f = fakeEndpoint({
    initialize: init,
    '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 12, resolvedProfileHash: null }),
    '_agnes/v1/session.readToolDetail': read,
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: providers,
  })
  return { f, client }
}

describe('Session.readToolDetail', () => {
  it('reads a still-pending call without inventing a result', async () => {
    const call = { toolUseId: 'pending', name: 'read', args: { path: 'x' }, ordinal: 0 }
    const bytes = Buffer.from(JSON.stringify({ call }))
    const { client } = harness(() => ({
      sessionId: 's',
      callSeq: 7,
      offset: 0,
      totalBytes: bytes.byteLength,
      data: bytes.toString('base64'),
      nextOffset: null,
    }))
    const session = await client.session.attach('s')
    await expect(session.readToolDetail(7)).resolves.toEqual({ call })
    await client.close()
  })

  it('reassembles complete pages without changing attach state', async () => {
    const call = { toolUseId: 'a', name: 'read', args: { path: 'x' }, ordinal: 0 }
    const result = {
      toolUseId: 'a',
      content: [{ type: 'text', text: 'large'.repeat(80_000) }],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'd' },
    }
    const bytes = Buffer.from(JSON.stringify({ call, result }))
    const { f, client } = harness((params) => {
      const { callSeq, resultSeq, offset } = params as {
        callSeq: number
        resultSeq: number
        offset: number
      }
      const start = offset as number
      const end = Math.min(bytes.byteLength, start + 256 * 1024)
      return {
        sessionId: 's',
        callSeq,
        resultSeq,
        offset: start,
        totalBytes: bytes.byteLength,
        data: bytes.subarray(start, end).toString('base64'),
        nextOffset: end < bytes.byteLength ? end : null,
      }
    })
    const session = await client.session.attach('s')
    const before = session.cursor()
    const detail = await session.readToolDetail(7, 9)
    expect(detail).toEqual({ call, result })
    expect(session.cursor()).toEqual(before)
    expect(session.attached).toBe(true)
    const reads = f.calls.filter((item) => item.method === '_agnes/v1/session.readToolDetail')
    expect(reads).toHaveLength(2)
    expect(reads.map((item) => item.params)).toEqual([
      { sessionId: 's', callSeq: 7, resultSeq: 9, offset: 0 },
      { sessionId: 's', callSeq: 7, resultSeq: 9, offset: 262144 },
    ])
    await client.close()
  })

  it('refuses pages that do not advance or mismatch the requested record', async () => {
    const { client } = harness(() => ({
      sessionId: 's',
      callSeq: 8,
      offset: 0,
      totalBytes: 10,
      data: '',
      nextOffset: 0,
    }))
    const session = await client.session.attach('s')
    await expect(session.readToolDetail(7)).rejects.toBeInstanceOf(ProtocolViolation)
    await client.close()
  })

  it('stops paging when the caller no longer needs the detail', async () => {
    const controller = new AbortController()
    const { f, client } = harness(() => {
      controller.abort()
      return {
        sessionId: 's',
        callSeq: 7,
        offset: 0,
        totalBytes: 1000,
        data: Buffer.alloc(100).toString('base64'),
        nextOffset: 100,
      }
    })
    const session = await client.session.attach('s')
    await expect(session.readToolDetail(7, undefined, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(f.calls.filter((item) => item.method === '_agnes/v1/session.readToolDetail')).toHaveLength(1)
    await client.close()
  })
})
describe('Session.deliverables', () => {
  const item = (callSeq: number, resultSeq: number) => ({
    callSeq,
    resultSeq,
    toolUseId: `t${callSeq}`,
    turnId: 'turn:1',
    structured: { deliverables: [] },
  })
  function deliverables(read: Handler) {
    const f = fakeEndpoint({
      initialize: init,
      '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 12, resolvedProfileHash: null }),
      '_agnes/v1/session.deliverables': read,
    })
    const client = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    return { f, client }
  }

  it('reads one page after the given seq without moving the attach cursor', async () => {
    const page = { sessionId: 's', upto: 9, items: [item(3, 5), item(4, 9)], nextAfterSeq: 9 }
    const { f, client } = deliverables(() => page)
    const session = await client.session.attach('s')
    const before = session.cursor()
    await expect(session.deliverables({ afterSeq: 2, limit: 2 })).resolves.toEqual(page)
    expect(session.cursor()).toEqual(before)
    expect(f.calls.filter((call) => call.method === '_agnes/v1/session.deliverables')).toEqual([
      expect.objectContaining({ params: { sessionId: 's', afterSeq: 2, limit: 2 } }),
    ])
    await client.close()
  })

  it.each([
    ['another session', { sessionId: 'other', upto: 9, items: [] }],
    ['an item at the cut', { sessionId: 's', upto: 9, items: [item(1, 2)] }],
    ['items out of result order', { sessionId: 's', upto: 9, items: [item(3, 8), item(4, 6)] }],
    ['a result past upto', { sessionId: 's', upto: 7, items: [item(3, 8)] }],
    ['a result before its call', { sessionId: 's', upto: 9, items: [item(8, 8)] }],
    ['more items than asked', { sessionId: 's', upto: 9, items: [item(3, 4), item(5, 6), item(7, 8)] }],
    ['a continuation off the last item', { sessionId: 's', upto: 9, items: [item(3, 4)], nextAfterSeq: 9 }],
    ['a continuation of an empty page', { sessionId: 's', upto: 2, items: [], nextAfterSeq: 2 }],
    ['a continuation away from upto', { sessionId: 's', upto: 9, items: [item(3, 4)], nextAfterSeq: 4 }],
    ['upto before the cut', { sessionId: 's', upto: 1, items: [] }],
  ])('refuses %s', async (_name, page) => {
    const { client } = deliverables(() => page)
    const session = await client.session.attach('s')
    await expect(session.deliverables({ afterSeq: 2, limit: 2 })).rejects.toBeInstanceOf(ProtocolViolation)
    await client.close()
  })
})
