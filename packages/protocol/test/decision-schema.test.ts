import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import * as M from '../gen/ts/model.js'
import { SLOT_NAMES, validateModelRecord, validatePreset, validateRouteTable } from '../src/index.js'

const decisionModel = {
  id: 'jev-1.13.0',
  name: 'Jev 1.13.0',
  api: 'typesafe-systemone',
  route: 'jev',
  baseUrl: 'https://api.typesafe.ai/v1',
  kind: 'decision',
  contextWindow: 64000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
}

const request = {
  slot: 'decision',
  route: 'jev',
  model: 'jev-1.13.0',
  state: 'the working tree is clean',
  questions: { done: { type: 'noul', instructions: 'Is the task finished?' } },
  timeoutMs: 1000,
}

const options = (n: number): Record<string, null> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, null]))

describe('decision model records', () => {
  it('need none of the chat record fields', () => {
    expect(Value.Check(M.DecisionModelRecord, decisionModel)).toBe(true)
    for (const key of ['toolCallFormats', 'thinkingReplay', 'maxTokens', 'input', 'reasoning', 'contract_id'])
      expect(Object.hasOwn(decisionModel, key), key).toBe(false)
  })

  it('cannot stand in for a chat record, nor the reverse', () => {
    expect(validateModelRecord(decisionModel).ok).toBe(false)
    expect(Value.Check(M.DecisionModelRecord, { ...decisionModel, maxTokens: 1 })).toBe(false)
    expect(Value.Check(M.DecisionModelRecord, { ...decisionModel, kind: 'chat' })).toBe(false)
  })

  it('can be declared on a route', () => {
    const route = {
      route: 'jev',
      api: 'typesafe-systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      credentialRef: 'secret://typesafe/default',
      models: [decisionModel],
    }
    expect(Value.Check(M.RouteDecl, route)).toBe(true)
    expect(Value.Check(M.RouteDecl, { ...route, models: [{ ...decisionModel, maxTokens: 1 }] })).toBe(false)
  })
})

describe('the route table', () => {
  it('takes an optional decision key that targets a route like any slot', () => {
    const primary = { route: 'gw', model: 'm' }
    expect(validateRouteTable({ primary }).ok).toBe(true)
    expect(validateRouteTable({ primary, decision: { route: 'jev', model: 'jev-1.13.0' } }).ok).toBe(true)
    expect(validateRouteTable({ primary, decision: { route: 'jev' } }).ok).toBe(false)
  })

  it('does not grow the chat slot set', () => {
    expect(SLOT_NAMES).not.toContain('decision')
    expect(Value.Check(M.SlotName, 'decision')).toBe(false)
    const body = {
      kind: 'inference',
      sessionKey: 'agnes:t:a:cli:dm:x',
      slot: 'decision',
      route: 'jev',
      model: 'jev-1.13.0',
      contractId: null,
      derivedHash: 'a'.repeat(64),
      system: 's',
      messages: [],
      tools: [],
    }
    expect(Value.Check(M.RequestBody, body)).toBe(false)
  })

  it('lets a preset route the decision slot but not give it a thinking level', () => {
    const route = { primary: { route: 'gw', model: 'm' }, decision: { route: 'jev', model: 'jev-1.13.0' } }
    expect(validatePreset({ name: 'p', model: { route } }).ok).toBe(true)
    expect(validatePreset({ name: 'p', model: { thinking: { primary: 'high' } } }).ok).toBe(true)
    expect(validatePreset({ name: 'p', model: { thinking: { decision: 'high' } } }).ok).toBe(false)
  })
})

describe('the decision wire request', () => {
  const ok = (x: unknown) => Value.Check(M.DecisionWireRequest, x)
  it('accepts the three question types, noul with or without criteria', () => {
    expect(ok(request)).toBe(true)
    expect(
      ok({
        ...request,
        questions: {
          done: { type: 'noul', instructions: 'x', criteria: { true: 'yes', false: { reason: 'no' } } },
          action: { type: 'choice', instructions: ['pick'], criteria: { infer: 'go on', stop: null } },
          effort: { type: 'score', instructions: { ask: 'how much' }, criteria: ['none', 'some', 'a lot'] },
        },
      }),
    ).toBe(true)
  })
  it.each([
    ['slot other than decision', { ...request, slot: 'primary' }],
    ['timeout below 100', { ...request, timeoutMs: 99 }],
    ['timeout above 2000', { ...request, timeoutMs: 2001 }],
    ['no questions', { ...request, questions: {} }],
    [
      '17 questions',
      {
        ...request,
        questions: Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }]),
        ),
      },
    ],
    [
      'a question id outside the pattern',
      { ...request, questions: { Done: { type: 'noul', instructions: 'x' } } },
    ],
    [
      'choice with one option',
      { ...request, questions: { a: { type: 'choice', instructions: 'x', criteria: options(1) } } },
    ],
    [
      'choice with 256 options',
      { ...request, questions: { a: { type: 'choice', instructions: 'x', criteria: options(256) } } },
    ],
    [
      'an option label with a space',
      {
        ...request,
        questions: { a: { type: 'choice', instructions: 'x', criteria: { 'go on': null, stop: null } } },
      },
    ],
    [
      'score with one level',
      { ...request, questions: { a: { type: 'score', instructions: 'x', criteria: ['a'] } } },
    ],
    [
      'score with eleven levels',
      { ...request, questions: { a: { type: 'score', instructions: 'x', criteria: Array(11).fill('l') } } },
    ],
    [
      'noul criteria without false',
      { ...request, questions: { a: { type: 'noul', instructions: 'x', criteria: { true: 'y' } } } },
    ],
    ['no route', { ...request, route: undefined }],
    ['no model', { ...request, model: undefined }],
    ['a route longer than 128', { ...request, route: 'r'.repeat(129) }],
    ['an unknown key', { ...request, fallbacks: [] }],
  ])('rejects %s', (_name, value) => {
    expect(ok(value)).toBe(false)
  })
  it('accepts exactly 255 options', () => {
    expect(
      ok({ ...request, questions: { a: { type: 'choice', instructions: 'x', criteria: options(255) } } }),
    ).toBe(true)
  })
})

describe('the decision wire result', () => {
  const result = {
    answers: {
      done: { type: 'noul', noul: 0.2 },
      action: { type: 'choice', choice: 'infer', probabilities: { infer: 0.9, stop: 0.1 }, confidence: 0.8 },
      effort: {
        type: 'score',
        score: 1.5,
        legend: { '0': 'none', '1': 'some', '2': 'a lot' },
        probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 },
        confidence: 0.6,
      },
    },
    model: 'jev-1.13.0',
    route: 'jev',
    usage: { inputTokens: 120, outputTokens: 3 },
    credits: 0.000504,
    creditSource: 'estimated',
  }
  it('accepts a priced result', () => {
    expect(Value.Check(M.DecisionWireResult, result)).toBe(true)
    expect(
      Value.Check(M.DecisionWireResult, { ...result, usage: { costUsd: 0.01 }, creditSource: 'gateway' }),
    ).toBe(true)
  })
  it.each([
    ['an unknown credit source', { ...result, creditSource: 'vendor' }],
    ['negative credits', { ...result, credits: -1 }],
    ['no route', { ...result, route: undefined }],
    ['negative token count', { ...result, usage: { inputTokens: -1 } }],
    [
      'a noul answer with confidence',
      { ...result, answers: { done: { type: 'noul', noul: 0.2, confidence: 1 } } },
    ],
  ])('rejects %s', (_name, value) => {
    expect(Value.Check(M.DecisionWireResult, value)).toBe(false)
  })
})
