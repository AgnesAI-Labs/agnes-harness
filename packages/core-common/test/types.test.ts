import { describe, expect, it } from 'vitest'
import { CoreError } from '../src/types.js'

describe('CoreError', () => {
  it('carries code and detail', () => {
    const e = new CoreError('E_WRITER_LEASE', 'stale writer', { expected: 'r1', actual: 'r2' })
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('E_WRITER_LEASE')
    expect(e.detail).toEqual({ expected: 'r1', actual: 'r2' })
    expect(e.message).toBe('E_WRITER_LEASE: stale writer')
  })
})
