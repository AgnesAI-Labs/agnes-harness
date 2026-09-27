import { readFileSync } from 'node:fs'
import type { DecisionWireRequest } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { DecisionAdapterError } from '../src/adapter.js'
import { NullContractStore } from '../src/contract-store.js'
import * as ai from '../src/index.js'
import { createProvider } from '../src/provider.js'
import {
  FAKE_DECISION_MODEL,
  FAKE_DECISION_ROUTE,
  FakeDecisionAdapter,
  type FakeDecisionScript,
  fakeDecisionRouteDecl,
} from '../testkit/index.js'

const REQ: DecisionWireRequest = {
  slot: 'decision',
  route: FAKE_DECISION_ROUTE,
  model: FAKE_DECISION_MODEL,
  state: 's',
  questions: { done: { type: 'noul', instructions: 'finished?' } },
  timeoutMs: 1000,
}
const call = (fake: FakeDecisionAdapter, signal = new AbortController().signal) =>
  fake.decide(FAKE_DECISION_ROUTE, REQ, { signal })

function facade(script: FakeDecisionScript) {
  const fake = new FakeDecisionAdapter(script)
  const provider = createProvider({
    adapters: [],
    decision: { adapters: [fake], routes: [fakeDecisionRouteDecl(script.route, script.model)] },
    routes: { primary: { route: 'unused', model: 'unused' } },
    contract: new NullContractStore(),
    secrets: () => '',
    clock: () => 0,
    pricing: { creditsPerUsd: 1 },
  })
  const decide = provider.decide
  if (!decide) throw new Error('no decide')
  const target = { route: script.route ?? FAKE_DECISION_ROUTE, model: script.model ?? FAKE_DECISION_MODEL }
  return {
    fake,
    decide: (req: DecisionWireRequest = REQ) =>
      decide({ ...req, ...target }, { signal: new AbortController().signal }),
  }
}

describe('FakeDecisionAdapter', () => {
  it('replays its steps in order and records each request', async () => {
    const fake = new FakeDecisionAdapter({
      steps: [
        { answers: { done: { type: 'noul', noul: 0.1 } } },
        {
          answers: { done: { type: 'noul', noul: 0.9 } },
          model: 'fake-decision-2',
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      ],
    })
    expect(fake.remaining).toBe(2)
    expect(await call(fake)).toEqual({
      answers: { done: { type: 'noul', noul: 0.1 } },
      model: FAKE_DECISION_MODEL,
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    expect(await call(fake)).toEqual({
      answers: { done: { type: 'noul', noul: 0.9 } },
      model: 'fake-decision-2',
      usage: { inputTokens: 5, outputTokens: 1 },
    })
    expect(fake.remaining).toBe(0)
    expect(fake.calls.map((c) => c.req.model)).toEqual([FAKE_DECISION_MODEL, FAKE_DECISION_MODEL])
    await expect(call(fake)).rejects.toThrow(/script exhausted/)
  })

  it('a hang settles only when its signal aborts', async () => {
    const fake = new FakeDecisionAdapter({ steps: [{ hang: true }] })
    const ac = new AbortController()
    let settled = false
    const pending = call(fake, ac.signal).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it.each([
    [401, 'AUTH'],
    [422, 'CONTRACT_MISMATCH'],
    [429, 'RATE_LIMIT'],
    [529, 'RATE_LIMIT'],
  ] as const)('http %i throws %s', async (http, code) => {
    const fake = new FakeDecisionAdapter({ steps: [{ http, retryAfter: '2' }] })
    const failure = call(fake)
    await expect(failure).rejects.toBeInstanceOf(DecisionAdapterError)
    await expect(failure).rejects.toMatchObject({ code, status: http, retryAfter: '2' })
  })

  it('returns a raw step exactly as scripted', async () => {
    const raw = { answers: 'not an object', model: 7 }
    const fake = new FakeDecisionAdapter({ steps: [{ raw }] })
    expect(await call(fake)).toBe(raw)
  })

  it('serves the route and model it was given', () => {
    const fake = new FakeDecisionAdapter({ route: 'dec', model: 'dm', steps: [] })
    expect(fake.routes()).toEqual(['dec'])
    expect(fake.models('dec').map((m) => [m.route, m.id, m.kind])).toEqual([['dec', 'dm', 'decision']])
    expect(fake.models('other')).toEqual([])
  })

  it('is not on the production entry point', () => {
    expect('FakeDecisionAdapter' in ai).toBe(false)
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(index).not.toMatch(/testkit|fake-decision/)
  })
})

describe('the facade over the fake maps each scripted failure', () => {
  it.each([
    [401, 'unavailable', 'AUTH'],
    [422, 'invalid', 'CONTRACT_MISMATCH'],
    [429, 'unavailable', 'RATE_LIMIT'],
    [529, 'unavailable', 'RATE_LIMIT'],
  ] as const)('http %i → %s', async (http, kind, code) => {
    await expect(facade({ steps: [{ http }] }).decide()).rejects.toMatchObject({ kind, code })
  })

  it('a hang is a timeout within timeoutMs', async () => {
    const started = Date.now()
    await expect(
      facade({ steps: [{ hang: true }] }).decide({ ...REQ, timeoutMs: 100 }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('a raw step with a broken envelope is invalid', async () => {
    await expect(facade({ steps: [{ raw: { answers: [], model: 'x' } }] }).decide()).rejects.toMatchObject({
      kind: 'invalid',
      code: 'FORMAT',
    })
  })

  it('a scripted answer comes back priced', async () => {
    const r = await facade({
      steps: [{ answers: { done: { type: 'noul', noul: 0.3 } }, usage: { inputTokens: 1_000_000 } }],
    }).decide()
    expect(r).toMatchObject({ route: FAKE_DECISION_ROUTE, credits: 0.042, creditSource: 'estimated' })
  })
})
