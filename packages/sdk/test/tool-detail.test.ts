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
