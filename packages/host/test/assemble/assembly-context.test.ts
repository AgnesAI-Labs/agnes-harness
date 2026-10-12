import { describe, expect, it } from 'vitest'
import { duplicateContribution, Late } from '../../src/runtime/assemble/context.js'

describe('Late assembly bindings', () => {
  it('refuses a read before the stage that builds the value has run', () => {
    const late = new Late<number>('kernel')
    expect(late.peek()).toBeUndefined()
    expect(() => late.get()).toThrow('kernel was read before it was built')
  })

  it('serves the value once it is set', () => {
    const late = new Late<{ id: string }>('seams')
    const value = { id: 'seams' }
    late.set(value)
    expect(late.get()).toBe(value)
    expect(late.peek()).toBe(value)
  })
})

describe('duplicate contributions', () => {
  it('are refused with the package error code and name the contribution', () => {
    expect(() => duplicateContribution('@agnes/a', 'preset', 'default')).toThrow(
      expect.objectContaining({
        code: 'E_PACKAGE_DUPLICATE',
        message: expect.stringContaining('@agnes/a: preset default is a duplicate'),
      }),
    )
  })
})
