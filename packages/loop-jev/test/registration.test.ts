import { loopKind } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { createJevLoopFactory, JEV_LOOP, jevLoopPlugin } from '../src/index.js'

describe('agnes.jev registration', () => {
  it('declares the agnes.jev identity, the steer control and its capabilities', () => {
    const factory = createJevLoopFactory()
    expect(JEV_LOOP).toEqual({ id: 'agnes.jev', version: '0.1.0' })
    expect([factory.id, factory.version]).toEqual(['agnes.jev', '0.1.0'])
    expect(factory.checkpointMode).toBe('driver')
    expect(factory.controls).toEqual({ steer: true })
    expect(factory.capabilities).toEqual(['model', 'tools', 'compaction', 'park', 'recovery'])
    expect(factory.codec.version).toBe(1)
  })
  it('registers exactly one loop factory under loopKind', () => {
    const registered: unknown[][] = []
    jevLoopPlugin.apply({
      providers: { register: (kind: unknown, value: unknown) => registered.push([kind, value]) },
    } as never)
    expect(jevLoopPlugin.inject).toEqual(['providers'])
    expect(registered).toHaveLength(1)
    expect(registered[0]?.[0]).toBe(loopKind)
  })
})
