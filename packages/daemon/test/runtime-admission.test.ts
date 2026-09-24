import { describe, expect, it } from 'vitest'
import { RuntimeAdmission } from '../src/runtime-admission.js'

const identity = Object.freeze({
  treeHash: 'a'.repeat(64),
  resourceRevision: 'b'.repeat(64),
  compositeRevision: 'c'.repeat(64),
})

function expected(source: 'lastGood' | 'bootstrap' = 'lastGood') {
  return {
    workerKind: 'session' as const,
    workerKey: '@shared' as const,
    generation: 3,
    digest: `sha256-${'d'.repeat(64)}`,
    identity,
    source,
  }
}

describe('RuntimeAdmission', () => {
  it('opens only when the six-tuple matches and treats a correct duplicate as idempotent', async () => {
    const admission = new RuntimeAdmission(expected())
    expect(admission.ready).toBe(false)
    const waiting = admission.whenReady()
    expect(admission.admit({ ...expected(), source: 'bootstrap' })).toBe(false)
    expect(admission.ready).toBe(false)
    expect(admission.admit({ ...expected(), generation: 2 })).toBe(false)
    expect(admission.admit({ ...expected(), workerKey: 'other' as '@shared' })).toBe(false)
    expect(admission.admit(expected())).toBe(true)
    expect(admission.ready).toBe(true)
    await waiting
    expect(admission.admit(expected())).toBe(true)
    await admission.whenReady()
  })

  it('refuses a lastGood expectation that reports bootstrap', () => {
    const admission = new RuntimeAdmission(expected('lastGood'))
    expect(admission.admit(expected('bootstrap'))).toBe(false)
    expect(admission.ready).toBe(false)
  })
})
