import { expect, it } from 'vitest'
import { type EventEnvelope, MODEL_CALL_EVENT, readModelCall, validateEvent } from '../src/index.js'

const start: EventEnvelope = {
  v: 1,
  seq: 2,
  ts: new Date().toISOString(),
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  type: MODEL_CALL_EVENT,
  origin: 'system',
  trust: 'trusted',
  ignorable: true,
  lane: 'main',
  data: {
    version: 1,
    id: 'call-1',
    scope: 'provider-call',
    purpose: 'title',
    parentEffectId: 'title-1',
    route: 'gw',
    model: 'requested',
    sourceTurn: 1,
    sourceStep: 0,
    stage: 'started',
  },
}
const settled: EventEnvelope = {
  ...start,
  seq: 4,
  sourceEventSeqs: [2],
  data: {
    ...(start.data as object),
    stage: 'settled',
    startedSeq: 2,
    outcome: 'cancelled',
    usage: null,
    observedModel: null,
  },
}

it('reads only trusted closed provider-call metadata with an exact prior start source', () => {
  expect(validateEvent(start).ok).toBe(true)
  expect(readModelCall(start)?.stage).toBe('started')
  expect(readModelCall(settled)).toMatchObject({ stage: 'settled', usage: null, outcome: 'cancelled' })
  for (const patch of [
    { origin: 'model' },
    { trust: 'untrusted' },
    { ignorable: false },
    { seq: 2 },
    { sourceEventSeqs: [1] },
    { sourceEventSeqs: [2, 3] },
  ])
    expect(readModelCall({ ...settled, ...patch } as EventEnvelope)).toBeUndefined()
  for (const patch of [
    { scope: 'wire-call' },
    { sourceTurn: 0 },
    { sourceStep: -1 },
    { request: { messages: [] } },
    {
      usage: {
        type: 'usage',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'estimated',
        response: { headers: { authorization: 'secret' } },
      },
    },
  ])
    expect(readModelCall({ ...settled, data: { ...(settled.data as object), ...patch } })).toBeUndefined()
})

it('keeps a frozen exact-route quote and rejects mismatched, future and malformed price evidence', () => {
  const pricing = {
    version: 1,
    basis: 'configured',
    route: 'gw',
    model: 'requested',
    admittedAt: Date.parse(start.ts),
    policy: { currency: 'CNY', unit: 'per-million-tokens', perMillion: { output: 0 } },
  }
  expect(readModelCall({ ...start, data: { ...(start.data as object), pricing } })?.pricing).toEqual(pricing)
  for (const patch of [
    { route: 'other' },
    { model: 'other' },
    { admittedAt: Date.parse(start.ts) + 1 },
    { policy: { ...pricing.policy, currency: 'credits' } },
  ])
    expect(
      readModelCall({ ...start, data: { ...(start.data as object), pricing: { ...pricing, ...patch } } }),
    ).toBeUndefined()
})
