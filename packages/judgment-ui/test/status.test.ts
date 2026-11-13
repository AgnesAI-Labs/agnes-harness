import { expect, it } from 'vitest'
import { parseJudgmentStatus } from '../src/status.js'

const use = { enabled: false, available: false, reason: 'disabled', requests: 0 }
const status = {
  version: 1,
  configurationRevision: 'a'.repeat(64),
  state: 'ready',
  reason: 'none',
  hookTimeout: 'unknown',
  cache: { hit: 7, miss: 9, size: 2 },
  uses: { stop: use, findRelevant: use, judgeBatch: use, rules: use },
}

it('accepts only bounded status fields without carrying additional private data', () => {
  expect(parseJudgmentStatus(status)).toEqual(status)
  for (const invalid of [
    null,
    { ...status, sessionId: 'private' },
    { ...status, configurationRevision: 'unbounded' },
    { ...status, state: 'authorized' },
    { ...status, state: { toString: () => 'ready' } },
    { ...status, reason: { toString: () => 'none' } },
    { ...status, hookTimeout: 15_000 },
    { ...status, cache: { hit: -1, miss: 0, size: 0 } },
    { ...status, cache: { hit: 0, miss: 0, size: 2001 } },
    { ...status, cache: { hit: Infinity, miss: 0, size: 0 } },
    { ...status, uses: { ...status.uses, rules: { ...use, text: 'private rule' } } },
    { ...status, uses: { ...status.uses, rules: { ...use, requests: 0.5 } } },
    { ...status, uses: { ...status.uses, rules: { ...use, reason: 'secret endpoint' } } },
    { ...status, uses: { ...status.uses, rules: { ...use, reason: { toString: () => 'disabled' } } } },
  ])
    expect(parseJudgmentStatus(invalid)).toBeNull()
})

it('keeps configured opt-in separate from effective native-only availability', () => {
  const result = parseJudgmentStatus({
    ...status,
    uses: {
      ...status.uses,
      findRelevant: { enabled: true, available: false, reason: 'native-required', requests: 3 },
      judgeBatch: { enabled: true, available: true, reason: 'none', requests: 4 },
    },
  })
  expect(result?.uses.findRelevant).toEqual({
    enabled: true,
    available: false,
    reason: 'native-required',
    requests: 3,
  })
  expect(result?.uses.judgeBatch.available).toBe(true)
})
