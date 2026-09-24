import { describe, expect, it } from 'vitest'
import { PackageError } from '../src/errors.js'

describe('PackageError message guard', () => {
  it('keeps the typed code when the reason looks like a credential', () => {
    const error = new PackageError('E_DEP_MISSING', 'value: sk-live-abc')
    expect(error).toBeInstanceOf(PackageError)
    expect(error.code).toBe('E_PACKAGE_SOURCE')
    expect(error.legacyCode).toBe('E_DEP_MISSING')
    expect(error.message).toBe('E_PACKAGE_SOURCE: error message omitted: looks like a secret')
    expect(error.reason).toBe('error message omitted: looks like a secret')
    expect(error.detail).toEqual({ redacted: true })
    expect(`${error.message} ${error.reason} ${JSON.stringify({ ...error })}`).not.toContain('sk-live-abc')
  })
})
