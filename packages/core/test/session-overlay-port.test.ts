import { describe, expect, it, vi } from 'vitest'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

describe('SessionOverlayPort', () => {
  it('is the setPreset path and isolates overlay failure from the session ledger write', async () => {
    const apply = vi.fn(async () => {
      throw new Error('overlay failed')
    })
    const { session } = await openSession({
      provider: fakeProvider([]),
      sessionOverlay: { apply },
    })
    const next = { ...presetDefaults(), name: 'other' }
    await expect(session.setPreset(next)).rejects.toThrow('overlay failed')
    expect(apply).toHaveBeenCalledWith(session.key, { preset: 'other' })
    expect(session.preset.name).not.toBe('other')
  })
})
