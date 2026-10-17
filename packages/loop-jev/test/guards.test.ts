import { describe, expect, it } from 'vitest'
import { checkNoProgress, failureSignature } from '../src/guards.js'
import type { HistoryEntry } from '../src/types.js'
import { fingerprint } from '../src/util.js'

const failed = (code: string, op: string | null = null): HistoryEntry => ({
  phase: null,
  operation: op,
  target: null,
  status: 'failed',
  disposition: 'NOT_APPLIED',
  summary: '',
  error: {
    code,
    kind: 'infrastructure',
    stage: 'decision',
    recoverability: 'recoverable',
    message: `E_MODEL_UNKNOWN: ${code}`,
  },
  intentFp: null,
  observationFp: fingerprint(`failed:${code}`),
  dispatched: false,
})
const ok = (fp: string): HistoryEntry => ({
  phase: 'INSPECT',
  operation: 'read',
  target: 'a',
  status: 'succeeded',
  disposition: 'SUCCEEDED',
  summary: '',
  intentFp: 'i',
  observationFp: fp,
  dispatched: true,
})

describe('no-progress limit', () => {
  it('signs a decision failure with an empty anchor', () => {
    expect(failureSignature(failed('MODEL_UNAVAILABLE'))).toBe(
      `decision|${fingerprint({ operation: null, target: null })}|MODEL_UNAVAILABLE`,
    )
    expect(failureSignature(ok('x'))).toBeNull()
  })
  it('stops at the third identical failure and reports the last error', () => {
    expect(checkNoProgress([failed('MODEL_UNAVAILABLE'), failed('MODEL_UNAVAILABLE')])).toBeNull()
    const limit = checkNoProgress([
      failed('MODEL_UNAVAILABLE'),
      failed('MODEL_UNAVAILABLE'),
      failed('MODEL_UNAVAILABLE'),
    ])
    expect(limit?.code).toBe('NO_PROGRESS_LIMIT')
    expect(limit?.last?.message).toContain('E_MODEL_UNKNOWN')
  })
  it('does not stop when failures differ and observations stay new', () => {
    expect(
      checkNoProgress([failed('MODEL_UNAVAILABLE'), failed('INVALID_PROPOSAL'), ok('a'), ok('b')]),
    ).toBeNull()
  })
  it('stops after three consecutive stale observations', () => {
    expect(checkNoProgress([ok('a'), ok('a'), ok('a')])).toBeNull()
    expect(checkNoProgress([ok('a'), ok('a'), ok('a'), ok('a')])?.code).toBe('NO_PROGRESS_LIMIT')
  })
  it('counts the same refusal code three times (ref test_kernel.py:954)', () => {
    const refused = (): HistoryEntry => ({
      ...failed('NO_CALL', 'write'),
      status: 'refused',
      error: { code: 'NO_CALL', kind: 'proposal', stage: 'llm', recoverability: 'recoverable', message: '' },
      observationFp: fingerprint('refused:NO_CALL'),
    })
    expect(checkNoProgress([refused(), ok('a'), refused(), ok('b'), refused()])?.code).toBe(
      'NO_PROGRESS_LIMIT',
    )
  })
})
