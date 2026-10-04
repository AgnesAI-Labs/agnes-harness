import { expect, it } from 'vitest'
import { createClient } from '../src/client.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

it.each([true, false])('advertises questions only with an explicit answerer (%s)', async (enabled) => {
  const input = {
    sessionId: 'session',
    interactionId: 'question',
    answer: { answers: [{ id: 'choice', selected: ['A'] }] },
  }
  const resolution = { sessionId: 'session', interactionId: 'question', status: 'answered', settledSeq: 5 }
  const f = fakeEndpoint({
    initialize: fakeEndpoint({}).initialize,
    '_agnes/v1/questions.pending': () => ({ sessionId: 'session', interactions: [] }),
    '_agnes/v1/questions.answer': () => resolution,
    '_agnes/v1/questions.cancel': () => ({ ...resolution, status: 'cancelled' }),
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    ...(enabled ? { questions: true } : {}),
  })
  try {
    expect(await client.questions.pending('session')).toEqual({ sessionId: 'session', interactions: [] })
    expect(await client.questions.answer(input)).toEqual(resolution)
    expect(await client.questions.cancel({ sessionId: 'session', interactionId: 'question' })).toEqual({
      ...resolution,
      status: 'cancelled',
    })
    expect(f.calls[0]?.params).toMatchObject({
      clientCapabilities: {
        _meta: {
          'ai.agnes.harness': { capabilities: { permission: true, ...(enabled ? { questions: true } : {}) } },
        },
      },
    })
    expect(f.calls.filter((call) => call.method !== 'initialize').map((call) => call.method)).toEqual([
      '_agnes/v1/questions.pending',
      '_agnes/v1/questions.answer',
      '_agnes/v1/questions.cancel',
    ])
    expect(client.sessions.size).toBe(0)
  } finally {
    await client.close()
  }
})
