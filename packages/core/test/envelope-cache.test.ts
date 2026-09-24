import { describe, expect, it } from 'vitest'
import type { SurfaceNode } from '../src/project/surface.js'
import { createEnvelopeCache, pruneEnvelopeCache } from '../src/request/envelope-cache.js'

const node = (seq: number): SurfaceNode =>
  ({ seq, kind: 'tool_result', pinned: false, event: {} as never }) as SurfaceNode

describe('pruneEnvelopeCache', () => {
  it('drops entries whose seq is no longer on the given surface, keeps the rest', () => {
    const cache = createEnvelopeCache()
    cache.set(1, ['a'])
    cache.set(2, ['b'])
    cache.set(3, ['c'])
    pruneEnvelopeCache(cache, [node(1), node(3)])
    expect([...cache.keys()].sort()).toEqual([1, 3])
  })

  it('is a no-op on an empty surface only if the cache is already empty; otherwise clears it', () => {
    const cache = createEnvelopeCache()
    cache.set(5, ['x'])
    pruneEnvelopeCache(cache, [])
    expect(cache.size).toBe(0)
  })
})
