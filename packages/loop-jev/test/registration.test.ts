import { loopKind } from '@agnes/extension-api'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { describe, expect, it } from 'vitest'
import { createJevLoopFactory, JEV_LOOP, jevLoopPlugin } from '../src/index.js'

describe('agnes.jev registration', () => {
  it('declares the identity, controls and capabilities of the spec', () => {
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
  // Pass-through skeleton only: the real driver asks Jev before any model request.
  it('skeleton: answers one prompt through driveLoop', async () => {
    const run = await driveLoop(createJevLoopFactory(), {
      inputs: [{ content: [{ type: 'text', text: 'hi' }] }],
      replies: [
        [
          { type: 'text_delta', delta: 'hello' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    expect(run.finished?.[0]).toBe('completed')
    expect(run.events).toContainEqual({
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: 'hello' }], stopReason: 'end_turn' },
    })
  })
})
