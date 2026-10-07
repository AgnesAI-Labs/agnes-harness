import { META_KEY, type JsonValue } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { runHeadless, type HeadlessRecord } from '../src/headless.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint, type Handler } from './helpers/fake-endpoint.js'
const event = (seq: number, type: string, data: JsonValue) => ({
  jsonrpc: '2.0' as const,
  method: '_agnes/v1/session.event',
  params: {
    sessionId: 's',
    event: {
      seq,
      ts: `2026-10-07T00:00:0${seq}.000Z`,
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type,
      data,
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
    },
    _meta: {
      [META_KEY]: { promptTurnId: '1', eventSequence: seq, generation: 1, lane: 'main', phase: 'event' },
    },
  },
})
function setup(prompt: Handler) {
  const f = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    'session/new': () => ({ sessionId: 's' }),
    '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
    '_agnes/v1/session.detach': () => ({}),
    'session/prompt': prompt,
    'session/cancel': () => ({}),
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal(),
    authProviders: { local: () => localAuth() },
  })
  return { client, f }
}
it('streams durable JSONL records and per-turn usage, without reusing a session key', async () => {
  const { client, f } = setup((_params, ctx) => {
    ctx.push(event(1, 'turn/start', { turn: 1, trigger: 'prompt' }))
    ctx.push(
      event(2, 'cost/ledger', {
        purpose: 'inference',
        effectId: 'i',
        tokens: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0 },
        creditSource: 'estimated',
        model: 'demo',
      }),
    )
    ctx.push(event(3, 'turn/end', { reason: 'completed', lastAssistantSeq: null }))
    return { stopReason: 'end_turn' }
  })
  const records: HeadlessRecord[] = []
  try {
    expect(
      await runHeadless(client, {
        cwd: '/workspace',
        input: 'Hello',
        runId: 'run-1',
        write: (record) => {
          records.push(record)
        },
      }),
    ).toMatchObject({ reason: 'completed', lastSeq: 3, eventsComplete: true })
    expect(records.map((row) => row.type)).toEqual([
      'start',
      'event',
      'event',
      'event',
      'turn-metrics',
      'result',
    ])
    expect(records.find((row) => row.type === 'turn-metrics')).toMatchObject({
      schemaVersion: 1,
      runId: 'run-1',
      metrics: {
        turn: 1,
        durationMs: 2000,
        toolCalls: 0,
        tokens: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0 },
        usageRecords: 1,
      },
    })
    expect(f.calls.find((row) => row.method === 'session/new')?.params).toMatchObject({
      _meta: { [META_KEY]: { sessionKey: expect.stringMatching(/^agnes:headless:/) } },
    })
    expect(f.calls.at(-1)?.method).toBe('_agnes/v1/session.detach')
  } finally {
    await client.close()
  }
})
it('reports missing usage as null and preserves a backend error outcome', async () => {
  const { client } = setup((_params, ctx) => {
    ctx.push(event(1, 'turn/start', { turn: 1, trigger: 'prompt' }))
    ctx.push(
      event(2, 'turn/end', {
        reason: 'error',
        lastAssistantSeq: null,
        error: { code: 'TRANSCRIPT_EXHAUSTED', message: 'No reply' },
      }),
    )
    throw new Error('No reply')
  })
  const records: HeadlessRecord[] = []
  try {
    expect(
      await runHeadless(client, {
        cwd: '/workspace',
        input: 'Hello',
        write: (row) => {
          records.push(row)
        },
      }),
    ).toMatchObject({ reason: 'error', eventsComplete: true })
    expect(records.find((row) => row.type === 'turn-metrics')).toMatchObject({
      metrics: { tokens: null, usageRecords: 0 },
    })
  } finally {
    await client.close()
  }
})
it('rejects an output failure and detaches rather than reporting success', async () => {
  const { client } = setup((_params, ctx) => {
    ctx.push(event(1, 'turn/start', { turn: 1, trigger: 'prompt' }))
    ctx.push(event(2, 'turn/end', { reason: 'completed', lastAssistantSeq: null }))
    return { stopReason: 'end_turn' }
  })
  try {
    await expect(
      runHeadless(client, {
        cwd: '/workspace',
        input: 'Hello',
        write: (row) => {
          if (row.type === 'event') throw new Error('sink failed')
        },
      }),
    ).rejects.toThrow('sink failed')
  } finally {
    await client.close()
  }
})
