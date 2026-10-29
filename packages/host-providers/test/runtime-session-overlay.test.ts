import { describe, expect, it } from 'vitest'
import { assertPresetOnlyOverlayRows, sessionOverlayDesired } from '../src/runtime-session-overlay.js'

describe('session overlay desired', () => {
  it('accepts a preset-only overlay and rejects extra fields', () => {
    expect(sessionOverlayDesired({ preset: 'coding' })).toEqual({ preset: 'coding' })
    expect(() => sessionOverlayDesired({ preset: 'coding', extra: true })).toThrow('E_SESSION_OVERLAY')
    expect(() => sessionOverlayDesired({ name: 'coding' })).toThrow('E_SESSION_OVERLAY')
    expect(() => sessionOverlayDesired('coding')).toThrow('E_SESSION_OVERLAY')
  })

  it('rejects non-preset overlay rows', () => {
    expect(() => assertPresetOnlyOverlayRows(['preset:coding'])).not.toThrow()
    expect(() => assertPresetOnlyOverlayRows(['ext:demo'])).toThrow('E_SESSION_OVERLAY')
    expect(() => assertPresetOnlyOverlayRows(['seam:approval'])).toThrow('E_SESSION_OVERLAY')
    expect(() => assertPresetOnlyOverlayRows(['llm'])).toThrow('E_SESSION_OVERLAY')
    expect(() => assertPresetOnlyOverlayRows(['compaction'])).toThrow('E_SESSION_OVERLAY')
    expect(() => assertPresetOnlyOverlayRows(['core-op:Inbox'])).toThrow('E_SESSION_OVERLAY')
    expect(() => assertPresetOnlyOverlayRows(['policy:approvals'])).toThrow('E_SESSION_OVERLAY')
    expect(() => assertPresetOnlyOverlayRows(['host:internal'])).toThrow('E_SESSION_OVERLAY')
    expect(() => assertPresetOnlyOverlayRows(['loader:prepared'])).toThrow('E_SESSION_OVERLAY')
  })
})
