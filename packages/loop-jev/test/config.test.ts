import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js'

describe('configuration', () => {
  it('fills every default in code when no configuration is given', () => {
    expect(resolveConfig(undefined)).toEqual({
      jev: { route: 'jev', model: 'typesafe/jev-1.13-20260917', deadlineMs: 15000, maxRetries: 2 },
      llmMaxAttempts: 2,
      thresholds: { escalate: 0.5, externalWriteMin: 0.6, ambiguityGate: 0.4, answerProgressFloor: null },
      stepCap: 30,
      stateTokenBudget: 24000,
      requestTokenBudget: 48000,
    })
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG)
  })
  it('merges nested keys', () => {
    expect(
      resolveConfig({ jev: { route: 'jev2' }, thresholds: { ambiguityGate: null }, stepCap: 20 }),
    ).toMatchObject({
      jev: { route: 'jev2', deadlineMs: 15000 },
      thresholds: { ambiguityGate: null, escalate: 0.5 },
      stepCap: 20,
    })
  })
  it.each([
    [{ jev: { deadlineMs: 500 } }, 'jev.deadlineMs'],
    [{ stepCap: 0 }, 'stepCap'],
    [{ thresholds: { ambiguityGate: 2 } }, 'thresholds.ambiguityGate'],
    [{ requestTokenBudget: 70000 }, 'requestTokenBudget'],
    [{ extra: 1 }, 'extra'],
    [{ jev: { maxRetries: 1.5 } }, 'jev.maxRetries'],
    [{ constructor: 1 }, 'constructor'],
    [{ toString: 1 }, 'toString'],
    [{ jev: { valueOf: 1 } }, 'jev.valueOf'],
    [JSON.parse('{"__proto__": 1}'), '__proto__'],
    [JSON.parse('{"jev": {"__proto__": 1}}'), 'jev.__proto__'],
  ])('rejects %j at %s', (input, path) => expect(() => resolveConfig(input)).toThrow(path))
})
