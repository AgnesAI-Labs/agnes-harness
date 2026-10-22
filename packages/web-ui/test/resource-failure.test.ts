import { describe, expect, it } from 'vitest'
import { resourceFailureCatalog, resourceFailureKey } from '../src/resource-failure.js'

describe('resourceFailureKey', () => {
  it('names the blocked removal instead of the generic failure', () => {
    const key = resourceFailureKey('RESOURCE_REMOVE_BLOCKED')
    expect(key).toBe('resource.error.removeBlocked')
    for (const catalog of Object.values(resourceFailureCatalog)) expect(catalog).toHaveProperty(key)
  })

  it('keeps unknown codes on the generic failure', () => {
    expect(resourceFailureKey('SOMETHING_ELSE')).toBe('resource.error.operation')
  })
})
