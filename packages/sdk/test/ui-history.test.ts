import { rpcError, UI_PROJECTION_RESYNC_REQUIRED } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { ProtocolViolation } from '../src/errors.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint, type Handler } from './helpers/fake-endpoint.js'

const providers = { local: () => localAuth() }
const init: Handler = fakeEndpoint({}).initialize

const user = (id: string, seq: number, text = '') => ({
  kind: 'user' as const,
  id,
  seq,
  content: text ? [{ type: 'text' as const, text }] : [],
})

function harness(methods: Record<string, Handler>) {
  const f = fakeEndpoint({
    initialize: init,
    '_agnes/v1/session.attach': () => ({ generation: 2, lastSeq: 9, resolvedProfileHash: null }),
    ...methods,
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: providers,
  })
  return { f, session: () => client.session.attach('s') }
}

describe('bounded UI opening and history SDK', () => {
  it('keeps the legacy full projectUI call unchanged', async () => {
    const timeline = {
      sessionId: 's',
      upto: 9,
      generation: 2,
      opState: null,
      nodes: [user('u9', 9)],
      turns: [],
    }
    const { f, session } = harness({ '_agnes/v1/session.projectUI': () => timeline })

    await expect((await session()).projectUI(9, { surface: 'web' })).resolves.toEqual(timeline)
    expect(f.calls.at(-1)).toEqual({
      method: '_agnes/v1/session.projectUI',
      params: { sessionId: 's', upto: 9, surface: 'web' },
    })
  })

  it('passes bounded opening options and preserves the opaque cursor byte-for-byte', async () => {
    const cursor = 'opaque.+/_=-do-not-interpret'
    const opening = {
      timeline: {
        sessionId: 's',
        upto: 9,
        generation: 2,
        opState: null,
        nodes: [user('u9', 9)],
        turns: [],
      },
      history: { hasEarlier: true as const, cursor, startIndex: 8, totalNodes: 9 },
    }
    const { f, session } = harness({ '_agnes/v1/session.projectUIOpening': () => opening })

    await expect(
      (await session()).projectUIOpening({ surface: 'tui', maxNodes: 12, maxBytes: 32_768 }),
    ).resolves.toEqual(opening)
    expect(f.calls.at(-1)).toEqual({
      method: '_agnes/v1/session.projectUIOpening',
      params: { sessionId: 's', surface: 'tui', maxNodes: 12, maxBytes: 32_768 },
    })
  })

  it('uses protocol defaults by omitting optional opening fields', async () => {
    const opening = {
      timeline: { sessionId: 's', upto: 0, generation: 2, opState: null, nodes: [], turns: [] },
      history: { hasEarlier: false as const, startIndex: 0, totalNodes: 0 },
    }
    const { f, session } = harness({ '_agnes/v1/session.projectUIOpening': () => opening })

    await (await session()).projectUIOpening()
    expect(f.calls.at(-1)).toEqual({
      method: '_agnes/v1/session.projectUIOpening',
      params: { sessionId: 's' },
    })
  })

  it('passes only the opaque history cursor and page budgets', async () => {
    const page = {
      sessionId: 's',
      generation: 2,
      cut: 9,
      nodes: [user('u1', 1)],
      turns: [],
      hasEarlier: false as const,
      startIndex: 0,
      totalNodes: 9,
    }
    const { f, session } = harness({ '_agnes/v1/session.projectUIHistory': () => page })

    await expect(
      (await session()).projectUIHistory('opaque.+/_=', { limit: 25, maxBytes: 65_536 }),
    ).resolves.toEqual(page)
    expect(f.calls.at(-1)).toEqual({
      method: '_agnes/v1/session.projectUIHistory',
      params: { sessionId: 's', cursor: 'opaque.+/_=', limit: 25, maxBytes: 65_536 },
    })
  })

  it('rejects out-of-contract input before sending the projection request', async () => {
    const { f, session } = harness({
      '_agnes/v1/session.projectUIOpening': () => {
        throw new Error('must not be called')
      },
    })
    const s = await session()

    await expect(s.projectUIOpening({ maxNodes: 0 })).rejects.toBeInstanceOf(ProtocolViolation)
    expect(f.calls.some((call) => call.method === '_agnes/v1/session.projectUIOpening')).toBe(false)
  })

  it('rejects structurally invalid server output through the method schema', async () => {
    const { session } = harness({
      '_agnes/v1/session.projectUIOpening': () => ({
        timeline: { sessionId: 's', upto: 9, generation: 2, opState: null, nodes: [], turns: [] },
        history: { hasEarlier: true, startIndex: 1, totalNodes: 1 },
      }),
    })

    await expect((await session()).projectUIOpening()).rejects.toBeInstanceOf(ProtocolViolation)
  })

  it('rejects schema-valid opening coordinates and session identity that cannot describe the tail window', async () => {
    const wrongCoordinates = harness({
      '_agnes/v1/session.projectUIOpening': () => ({
        timeline: {
          sessionId: 's',
          upto: 9,
          generation: 2,
          opState: null,
          nodes: [user('u9', 9)],
          turns: [],
        },
        history: { hasEarlier: true, cursor: 'c', startIndex: 8, totalNodes: 10 },
      }),
    })
    await expect((await wrongCoordinates.session()).projectUIOpening()).rejects.toThrow(
      /opening window coordinates mismatch/,
    )

    const wrongSession = harness({
      '_agnes/v1/session.projectUIOpening': () => ({
        timeline: { sessionId: 'other', upto: 0, generation: 2, opState: null, nodes: [], turns: [] },
        history: { hasEarlier: false, startIndex: 0, totalNodes: 0 },
      }),
    })
    await expect((await wrongSession.session()).projectUIOpening()).rejects.toThrow(
      /opening session mismatch/,
    )
  })

  it('rejects pages that exceed caller limits, byte budgets, or global coordinates', async () => {
    const tooMany = harness({
      '_agnes/v1/session.projectUIHistory': () => ({
        sessionId: 's',
        generation: 2,
        cut: 9,
        nodes: [user('u1', 1), user('u2', 2)],
        turns: [],
        hasEarlier: false,
        startIndex: 0,
        totalNodes: 9,
      }),
    })
    await expect((await tooMany.session()).projectUIHistory('c', { limit: 1 })).rejects.toThrow(
      /history node limit exceeded/,
    )

    const badCoordinates = harness({
      '_agnes/v1/session.projectUIHistory': () => ({
        sessionId: 's',
        generation: 2,
        cut: 9,
        nodes: [user('u9', 9)],
        turns: [],
        hasEarlier: true,
        cursor: 'older',
        startIndex: 9,
        totalNodes: 9,
      }),
    })
    await expect((await badCoordinates.session()).projectUIHistory('c')).rejects.toThrow(
      /history page coordinates mismatch/,
    )

    const tooLarge = harness({
      '_agnes/v1/session.projectUIHistory': () => ({
        sessionId: 's',
        generation: 2,
        cut: 9,
        nodes: [user('u1', 1, 'x'.repeat(17_000))],
        turns: [],
        hasEarlier: false,
        startIndex: 0,
        totalNodes: 9,
      }),
    })
    await expect((await tooLarge.session()).projectUIHistory('c', { maxBytes: 16_384 })).rejects.toThrow(
      /history byte limit exceeded/,
    )
  })

  it('preserves resync and cursor errors for the TUI state machine instead of guessing a replacement', async () => {
    const resync = harness({
      '_agnes/v1/session.projectUIPatch': () =>
        Promise.reject(rpcError('INTERNAL_ERROR', { code: UI_PROJECTION_RESYNC_REQUIRED })),
    })
    await expect((await resync.session()).projectUIPatch(9)).rejects.toMatchObject({
      code: -32603,
      data: { code: UI_PROJECTION_RESYNC_REQUIRED },
    })

    const stale = harness({
      '_agnes/v1/session.projectUIHistory': () =>
        Promise.reject(rpcError('GENERATION_STALE', { generation: 3 })),
    })
    await expect((await stale.session()).projectUIHistory('opaque')).rejects.toMatchObject({
      code: -32004,
      data: { code: 'GENERATION_STALE', generation: 3 },
    })
  })
})
