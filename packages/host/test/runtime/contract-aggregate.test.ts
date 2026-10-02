import { contracts } from '@agnes/extension-api/testkit'
import { describe, expect, it } from 'vitest'

describe('contract aggregate', () => {
  it('loads a contract case from the testkit entry', () => {
    expect(typeof contracts.registerConfigContract).toBe('function')
  })
})
