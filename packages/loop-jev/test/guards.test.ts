import { describe, expect, it } from 'vitest'
import {
  checkAvailable,
  checkDuplicate,
  checkNoProgress,
  duplicateMessage,
  failureSignature,
  UNAVAILABLE_MESSAGE,
} from '../src/guards.js'
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
  it('counts the same refusal code three times', () => {
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

const run = (intentFp: string, observationFp: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  phase: 'INSPECT',
  operation: 'read',
  target: 'a.ts',
  status: 'succeeded',
  disposition: 'SUCCEEDED',
  summary: 's',
  intentFp,
  observationFp,
  dispatched: true,
  ...over,
})

describe('repeat guard', () => {
  it('refuses the third identical intent after two identical observations', () => {
    expect(checkDuplicate([run('I', 'O'), run('I', 'O')], 'I', 'read')).toEqual({
      code: 'DUPLICATE_NO_PROGRESS',
      message: duplicateMessage('read'),
    })
    expect(duplicateMessage('shell')).toBe(
      'shell repeated twice with the same arguments and observation; refusing a third execution without new information.',
    )
  })
  it('lets the third run when the two observations differ', () => {
    expect(checkDuplicate([run('I', 'O1'), run('I', 'O2')], 'I', 'read')).toBeNull()
  })
  it('lets the first and second run', () => {
    expect(checkDuplicate([], 'I', 'read')).toBeNull()
    expect(checkDuplicate([run('I', 'O')], 'I', 'read')).toBeNull()
  })
  it('lets a read of another range run', () => {
    expect(checkDuplicate([run('I1', 'O'), run('I1', 'O')], 'I2', 'read')).toBeNull()
  })
  it('counts only dispatched entries', () => {
    const refused = run('I', 'refused', { dispatched: false, status: 'refused', disposition: 'NOT_APPLIED' })
    expect(checkDuplicate([run('I', 'O'), refused, run('I', 'O')], 'I', 'read')).not.toBeNull()
    expect(checkDuplicate([run('I', 'O'), run('I', 'O', { dispatched: false })], 'I', 'read')).toBeNull()
  })
  it('compares the two latest runs of the intent', () => {
    expect(checkDuplicate([run('I', 'O1'), run('I', 'O2'), run('I', 'O2')], 'I', 'read')).not.toBeNull()
    expect(checkDuplicate([run('I', 'O2'), run('I', 'O2'), run('I', 'O3')], 'I', 'read')).toBeNull()
  })
  it('a change by another call resets the count', () => {
    const edit = run('E', 'X', { operation: 'edit', phase: 'ACT', changed_files: ['a.ts'] })
    expect(checkDuplicate([run('I', 'O'), run('I', 'O'), edit], 'I', 'read')).toBeNull()
    expect(checkDuplicate([run('I', 'O'), edit, run('I', 'O'), run('I', 'O')], 'I', 'read')).not.toBeNull()
  })
  it('only the latest change by another intent bounds the window', () => {
    const edit = (fp: string) => run(fp, 'X', { operation: 'edit', phase: 'ACT', changed_files: ['a.ts'] })
    expect(checkDuplicate([edit('E1'), run('I', 'O'), run('I', 'O'), edit('E2')], 'I', 'read')).toBeNull()
  })
  it('a call that may have changed files resets the count', () => {
    const shell = run('S', 'X', { operation: 'shell', target: null, files_may_have_changed: true })
    expect(checkDuplicate([run('I', 'O'), run('I', 'O'), shell], 'I', 'read')).toBeNull()
  })
  it('an unchanging call by another intent does not reset the count', () => {
    expect(checkDuplicate([run('I', 'O'), run('J', 'P'), run('I', 'O')], 'I', 'read')).not.toBeNull()
    expect(
      checkDuplicate([run('I', 'O'), run('I', 'O'), run('J', 'P', { changed_files: [] })], 'I', 'read'),
    ).not.toBeNull()
  })
  it('still refuses a repeated shell command that changes files', () => {
    const shell = (fp: string) =>
      run('S', fp, { operation: 'shell', target: null, files_may_have_changed: true })
    expect(checkDuplicate([shell('O'), shell('O')], 'S', 'shell')).not.toBeNull()
  })
  it('treats an unknown effect of another call as a change', () => {
    const unknown = run('W', 'U', { operation: 'shell', status: 'failed', disposition: 'UNKNOWN' })
    expect(checkDuplicate([run('I', 'O'), run('I', 'O'), unknown], 'I', 'read')).toBeNull()
  })
  it('ignores an unknown effect that was never dispatched', () => {
    const held = run('W', 'U', { disposition: 'UNKNOWN', dispatched: false })
    expect(checkDuplicate([run('I', 'O'), run('I', 'O'), held], 'I', 'read')).not.toBeNull()
  })
  it('ignores entries without an intent fingerprint', () => {
    expect(
      checkDuplicate([run('I', 'O'), failed('MODEL_UNAVAILABLE'), run('I', 'O')], 'I', 'read'),
    ).not.toBeNull()
  })
})

describe('availability', () => {
  it('refuses a call whose tool is no longer among the turn tool names', () => {
    expect(checkAvailable(['read', 'read'], ['ls', 'read'])).toBeNull()
    expect(UNAVAILABLE_MESSAGE).toBe('Selected operation is no longer available.')
    expect(checkAvailable(['write'], ['ls', 'read'])).toEqual({
      code: 'UNAVAILABLE',
      message: UNAVAILABLE_MESSAGE,
    })
    expect(checkAvailable(['read', 'write'], ['ls', 'read'])).not.toBeNull()
    expect(checkAvailable([], ['ls'])).toBeNull()
  })
})
