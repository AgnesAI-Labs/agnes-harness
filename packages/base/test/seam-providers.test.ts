import { describe, expect, it } from 'vitest'
import { BASE_SEAM_PROVIDERS, seamProvidersPlugin } from '../src/seam-providers.js'

describe('base seam providers', () => {
  it('registers the seven seam kinds under @agnes/base through ctx.providers', () => {
    const registered: Array<[string, string, string]> = []
    seamProvidersPlugin.apply({
      providers: {
        register: (kind: string, source: string, provider: { id: string }) => {
          registered.push([kind, source, provider.id])
          return async () => undefined
        },
      },
    } as never)
    expect(registered).toEqual([
      ['approval', '@agnes/base', 'local-prompt'],
      ['principals', '@agnes/base', 'local'],
      ['billing', '@agnes/base', 'budget'],
      ['checkpoint', '@agnes/base', 'fs'],
      ['artifacts', '@agnes/base', 'local'],
      ['verifier', '@agnes/base', 't0'],
      ['repair', '@agnes/base', 'default'],
    ])
  })

  it('gives every provider a semver version and a create()', () => {
    for (const provider of Object.values(BASE_SEAM_PROVIDERS)) {
      expect(provider.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(typeof provider.create).toBe('function')
    }
  })
})
