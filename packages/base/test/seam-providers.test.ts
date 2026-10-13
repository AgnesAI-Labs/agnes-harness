import { describe, expect, it } from 'vitest'
import { BASE_SEAM_PROVIDERS, seamProvidersPlugin } from '../src/seam-providers.js'

describe('base seam providers', () => {
  it('registers the seven seam kinds through ctx.providers', () => {
    const registered: Array<[string, string]> = []
    seamProvidersPlugin.apply({
      providers: {
        register: (kind: { kind: string }, provider: { id: string }) => {
          registered.push([kind.kind, provider.id])
          return async () => undefined
        },
      },
    } as never)
    expect(registered).toEqual([
      ['approval', 'local-prompt'],
      ['principals', 'local'],
      ['billing', 'budget'],
      ['checkpoint', 'fs'],
      ['artifacts', 'local'],
      ['verifier', 't0'],
      ['repair', 'default'],
    ])
  })

  it('gives every provider a semver version and a create()', () => {
    for (const provider of Object.values(BASE_SEAM_PROVIDERS)) {
      expect(provider.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(typeof provider.create).toBe('function')
    }
  })
})
