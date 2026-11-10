import type { EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { memoryJournal } from '../../packages/sdk/src/journal.js'
import { Session } from '../../packages/sdk/src/session.js'
import * as ledger from './ledger.js'

function event(seq: number, type: string, data: EventEnvelope['data']): EventEnvelope {
  return {
    seq,
    type,
    data,
    id: `01JGFJJZ00000000000000000${seq}`,
    ts: '2026-01-01T00:00:00.000Z',
    v: 1,
    lane: 'main',
    actor: { id: 'test', org: 'test', role: 'owner', deptPath: [], attrs: {} },
    origin: 'system',
    trust: 'trusted',
  }
}

const rows = [
  event(1, 'x/test/evidence', { value: 'full prefix' }),
  event(2, 'cost/ledger', {
    purpose: 'inference',
    effectId: 'inference-1',
    model: 'test',
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    creditSource: 'estimated',
    billing: { usdMicros: 123, source: 'estimated', subscription: false },
  }),
  event(3, 'turn/end', { reason: 'error', lastAssistantSeq: null }),
] as const

// Keep the real SDK's exclusive replay cursor and detach semantics; only RPC is synthetic.
function replay() {
  const journal = memoryJournal()
  let session: Session
  const client = {
    initialize: async () => {},
    bufferLimit: 1000,
    journal,
    notice: (notice: unknown) => {
      throw new Error(`Invalid synthetic event: ${JSON.stringify(notice)}`)
    },
    async call(method: string, params: { cursor?: { fromSeq: number } }) {
      if (method === '_agnes/v1/session.projectUI') return { upto: 3 }
      if (method === '_agnes/v1/session.detach') return {}
      if (method !== '_agnes/v1/session.attach') throw new Error(`Unexpected ${method}`)
      for (const event of rows.filter((row) => row.seq > (params.cursor?.fromSeq ?? 0)))
        session.onNotification('_agnes/v1/session.event', {
          sessionId: 'evidence',
          event,
          _meta: {
            'ai.agnes.harness': {
              promptTurnId: '1',
              eventSequence: event.seq,
              generation: 1,
              lane: 'main',
              phase: 'event',
            },
          },
        })
      return { generation: 1, lastSeq: 3, resolvedProfileHash: null }
    },
  }
  session = new Session(client as never, 'evidence')
  return session
}

it('shares one full snapshot across sequential and concurrent evidence consumers', async () => {
  const session = replay()
  const read = ledger.createSessionEventSnapshot(session)
  const concurrent = await Promise.all([read(), read()])
  const subsequent = await read()
  for (const events of [...concurrent, subsequent]) {
    expect(events.map(({ seq, type, data }) => ({ seq, type, data }))).toEqual(
      rows.map(({ seq, type, data }) => ({ seq, type, data })),
    )
    expect(events.filter((event) => event.type === 'cost/ledger').map((event) => event.data)).toEqual([
      rows[1].data,
    ])
    expect(events.filter((event) => event.type === 'turn/end').map((event) => event.data)).toEqual([
      { reason: 'error', lastAssistantSeq: null },
    ])
  }
})

it('retains the first replay error for every consumer even when detach also fails', async () => {
  const error = new Error('replay failed')
  const session = {
    projectUI: async () => ({ upto: 3 }),
    events: async function* () {
      yield rows[0]
      throw error
    },
    detach: async () => {
      throw new Error('TransportClosed during detach')
    },
  } as unknown as Session
  const read = ledger.createSessionEventSnapshot(session)
  await expect(read()).rejects.toBe(error)
  await expect(read()).rejects.toBe(error)
})

it('refuses a replay that ends before the projection watermark', async () => {
  const session = {
    projectUI: async () => ({ upto: 3 }),
    events: async function* () {
      yield rows[0]
    },
    detach: async () => {},
  } as unknown as Session
  await expect(ledger.readSessionEvents(session)).rejects.toThrow('before watermark 3')
})

it.each([
  ['consumed prefix', [rows[1], rows[2]]],
  ['missing middle', [rows[0], rows[2]]],
])('refuses a partial replay with %s even when it reaches the watermark', async (_label, events) => {
  const session = {
    projectUI: async () => ({ upto: 3 }),
    events: async function* () {
      yield* events
    },
    detach: async () => {},
  } as unknown as Session
  await expect(ledger.readSessionEvents(session)).rejects.toThrow('Incomplete session replay')
})

it('retains detach failures after an otherwise complete replay', async () => {
  const error = new Error('detach failed')
  const session = {
    projectUI: async () => ({ upto: 0 }),
    detach: async () => {
      throw error
    },
  } as unknown as Session
  // An empty projection has no stream to detach and remains legitimate evidence.
  await expect(ledger.readSessionEvents(session)).resolves.toEqual([])
  Object.assign(session, {
    projectUI: async () => ({ upto: 3 }),
    events: async function* () {
      yield* rows
    },
  })
  await expect(ledger.readSessionEvents(session)).rejects.toBe(error)
})
