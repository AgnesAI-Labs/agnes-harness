import { describe, expect, it } from 'vitest'
import type { Context } from '../src/index.js'
import { defineAgnesPlugin } from '../src/index.js'

describe('plugin author API', () => {
  it('preserves a standard Cordis plugin without wrapping it', () => {
    const plugin = (ctx: Context, config: { readonly greeting: string }) => {
      void ctx
      return config.greeting
    }

    expect(defineAgnesPlugin(plugin)).toBe(plugin)
  })

  it('keeps the runtime root surface author-only', async () => {
    expect(Object.keys(await import('../src/index.js')).sort()).toEqual(['defineAgnesPlugin'])
  })
})
