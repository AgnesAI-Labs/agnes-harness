import { describe, expect, it } from 'vitest'
import { EXTENSION_ERROR_CODES, ExtensionError, isExtensionError } from '../src/index.js'

describe('ExtensionError', () => {
  it('freezes the twelve author-visible codes', () => {
    expect([...EXTENSION_ERROR_CODES]).toEqual([
      'E_SERVICE_DEF',
      'E_PROJECTION_DEF',
      'E_PROJECTION_STATE',
      'E_CAPABILITY_UNDECLARED',
      'E_LEASE_EXPIRED',
      'E_TOOLDEF_META',
      'E_REGISTRY_DUPLICATE',
      'E_SLOT_PAYLOAD',
      'E_EVENT_NAMESPACE',
      'E_HOOK_RETURN',
      'E_API_RANGE',
      'E_CEILING_EXCEEDED',
    ])
  })
  it('really freezes the array at runtime, not just in the type', () => {
    expect(Object.isFrozen(EXTENSION_ERROR_CODES)).toBe(true)
    expect(() => (EXTENSION_ERROR_CODES as unknown as string[]).push('E_MADE_UP')).toThrow(TypeError)
    expect(EXTENSION_ERROR_CODES).toHaveLength(12)
  })
  it('passes cause through to Error, and omits it when not given', () => {
    const root = new Error('socket hang up')
    const wrapped = new ExtensionError('E_LEASE_EXPIRED', 'lease gone', { cause: root })
    expect(wrapped.cause).toBe(root)
    expect(new ExtensionError('E_LEASE_EXPIRED', 'lease gone')).not.toHaveProperty('cause')
  })
  it('carries code, extId and detail; message starts with the code', () => {
    const e = new ExtensionError('E_TOOLDEF_META', 'missing keys', {
      extId: 'xinwei/sales-analysis',
      detail: { missing: ['replay'] },
    })
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('E_TOOLDEF_META')
    expect(e.extId).toBe('xinwei/sales-analysis')
    expect(e.detail).toEqual({ missing: ['replay'] })
    expect(e.message).toBe('E_TOOLDEF_META: missing keys')
    expect(e.name).toBe('ExtensionError')
    expect(isExtensionError(e)).toBe(true)
    expect(isExtensionError(new Error('x'))).toBe(false)
    expect(isExtensionError({ code: 'E_TOOLDEF_META' })).toBe(false)
  })
})
