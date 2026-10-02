import { describe, expect, it } from 'vitest'
import type * as Testkit from '../../../extension-api/testkit/index.js'

type RegisterConfig = typeof Testkit.contracts.registerConfigContract

describe('contract aggregate', () => {
  it('resolves a contract case type from the testkit entry', () => {
    const kind: RegisterConfig extends (...args: never[]) => unknown ? 'function' : 'other' = 'function'
    expect(kind).toBe('function')
  })
})
