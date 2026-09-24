import { describe, expect, it } from 'vitest'
import { decideBackendAvailability } from '../src/availability.js'

describe('backend availability policy', () => {
  it('uses an available backend without claiming how it enforces', () => {
    expect(decideBackendAvailability({ available: true, required: true, onUnavailable: 'deny' })).toEqual({
      action: 'use-backend',
    })
  })

  it('refuses initialization when a required backend is unavailable', () => {
    expect(decideBackendAvailability({ available: false, required: true, onUnavailable: 'allow' })).toEqual({
      action: 'refuse-init',
      code: 'E_SEAM_INIT',
      reason: 'required-unavailable',
    })
  })

  it.each([undefined, 'deny', 'park', '', 0, false])(
    'defaults unavailable backend to deny for %j',
    (onUnavailable) => {
      expect(decideBackendAvailability({ available: false, required: false, onUnavailable })).toEqual({
        action: 'deny-operation',
        code: 'SANDBOX_UNAVAILABLE',
        reason: 'backend-unavailable',
      })
    },
  )

  it('denies when the complete unavailable policy is absent', () => {
    expect(decideBackendAvailability({ available: false })).toEqual({
      action: 'deny-operation',
      code: 'SANDBOX_UNAVAILABLE',
      reason: 'backend-unavailable',
    })
  })

  it('allows an unconfined process only after an exact explicit opt-in', () => {
    expect(decideBackendAvailability({ available: false, required: false, onUnavailable: 'allow' })).toEqual({
      action: 'allow-unconfined',
    })
  })

  it.each([null, 0, 'true', 'false'])('fails closed for invalid required=%j', (required) => {
    expect(decideBackendAvailability({ available: false, required, onUnavailable: 'allow' })).toEqual({
      action: 'refuse-init',
      code: 'E_SEAM_INIT',
      reason: 'invalid-config',
    })
  })
})
