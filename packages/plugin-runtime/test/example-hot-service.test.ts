import { Context, type Plugin } from '@agnes/cordis'
import { describe, expect, it } from 'vitest'

// The example plugins are plain ES modules under examples/, not workspace packages, so they are
// imported by path. They have no imports of their own: that is what lets an installed snapshot
// load without resolving any dependency.
const load = async (release: 'v1' | 'v2' | 'broken') =>
  (await import(`../../../examples/packages/hot-service/${release}/index.mjs`)) as {
    hotService: Plugin
  }

type Stats = { engine: string; label: string; stats(text: string): Record<string, number> }
const service = (ctx: Context): Stats | undefined =>
  (ctx as Context & { demoTextStats?: Stats }).demoTextStats

describe('hot-service example plugin', () => {
  it('v1 provides demoTextStats and disposes cleanly', async () => {
    const root = new Context()
    const { hotService } = await load('v1')
    const fiber = root.plugin(hotService, { label: '  shown  ' })
    await fiber
    expect(service(root)?.engine).toBe('v1')
    expect(service(root)?.label).toBe('shown')
    expect(service(root)?.stats('one two  three')).toEqual({ characters: 14, words: 3 })
    await fiber.dispose()
    expect(service(root)).toBeUndefined()
  })

  it('a configuration update re-applies the plugin with the new label', async () => {
    const root = new Context()
    const { hotService } = await load('v1')
    const fiber = root.plugin(hotService, {})
    await fiber
    expect(service(root)?.label).toBe('demo')
    await fiber.update({ label: 'renamed' })
    await fiber.await()
    expect(service(root)?.label).toBe('renamed')
    expect(() => fiber.update({ label: 42 } as never)).toThrow(/label must be a string/)
    expect(service(root)?.label).toBe('renamed')
    await fiber.dispose()
  })

  it('swapping v1 for v2 replaces the service and v2 reports line counts', async () => {
    const root = new Context()
    const v1 = await load('v1')
    const v2 = await load('v2')
    const first = root.plugin(v1.hotService, {})
    await first
    expect(service(root)?.engine).toBe('v1')
    await first.dispose()
    expect(service(root)).toBeUndefined()
    const second = root.plugin(v2.hotService, {})
    await second
    expect(service(root)?.engine).toBe('v2')
    expect(service(root)?.stats('a b\nc')).toEqual({ characters: 5, words: 3, lines: 2 })
    await second.dispose()
  })

  it('broken registers its service and then throws, and leaves nothing mounted', async () => {
    const root = new Context()
    const { hotService } = await load('broken')
    let failure: unknown
    try {
      await root.plugin(hotService, {})
    } catch (error) {
      failure = error
    }
    expect(String(failure)).toMatch(/failed after registering demoTextStats/)
    expect(service(root)).toBeUndefined()
  })
})
