import { providedExternalModules, registerProvidedExternal } from '@agnes/plugin-runtime/provided-externals'
import { describe, expect, it } from 'vitest'

describe('provided external modules', () => {
  it('refuses names outside the host contract table and keeps the table closed', () => {
    const hadProtocol = Object.hasOwn(providedExternalModules, '@agnes/protocol')
    expect(Object.hasOwn(providedExternalModules, '@agnes/plugin-runtime')).toBe(true)
    expect(Object.keys({ ...providedExternalModules })).toContain('@agnes/extension-api')
    expect(() => registerProvidedExternal('@agnes/plugin-runtime/host', {})).toThrow(TypeError)
    expect(Object.hasOwn(providedExternalModules, '@agnes/plugin-runtime/host')).toBe(false)
    expect(() => registerProvidedExternal('@agnes/protocol', null as never)).toThrow(TypeError)
    expect(Object.hasOwn(providedExternalModules, '@agnes/protocol')).toBe(hadProtocol)
    expect(() => {
      ;(providedExternalModules as Record<string, unknown>)['@agnes/plugin-runtime/host'] = {}
    }).toThrow(TypeError)
    expect(() => {
      delete (providedExternalModules as Record<string, unknown>)['@agnes/cordis']
    }).toThrow(TypeError)
    expect(Object.hasOwn(providedExternalModules, '@agnes/cordis')).toBe(true)
  })
})
