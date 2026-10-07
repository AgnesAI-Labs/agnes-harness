import type { ModelAdapterInstance } from '@agnes/extension-api'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { defineModelAdapter } from '../src/index.js'
import { runModelAdapter } from './model-adapter.js'

const request = {
  kind: 'inference' as const,
  sessionKey: 'test',
  slot: 'primary' as const,
  route: 'demo',
  model: 'demo',
  contractId: null,
  derivedHash: '0'.repeat(64),
  system: 'test',
  messages: [],
  tools: [],
}

describe('model adapter authoring', () => {
  it('preserves declarations, captures stream/complete events, and disposes instances on every path', async () => {
    let disposed = false
    const adapter = defineModelAdapter({
      id: 'demo',
      version: '1.0.0',
      api: 'demo-wire',
      capabilities: { imageInput: false, tools: false, streaming: true },
      create(config): ModelAdapterInstance {
        expectTypeOf(config.routes).toMatchTypeOf<readonly unknown[]>()
        return {
          id: 'demo-instance',
          routes: () => [],
          models: () => [],
          async *stream(_route, _request, options) {
            options.signal.throwIfAborted()
            yield { type: 'text_delta', delta: 'hello' }
            yield { type: 'done', reason: 'stop' }
          },
          complete: async () => [{ type: 'done', reason: 'stop' }],
          dispose() {
            disposed = true
          },
        }
      },
    })
    expect(defineModelAdapter(adapter)).toBe(adapter)
    const options = { config: { routes: [] }, route: 'demo', request }
    expect((await runModelAdapter(adapter, options)).events).toEqual([
      { type: 'text_delta', delta: 'hello' },
      { type: 'done', reason: 'stop' },
    ])
    expect(disposed).toBe(true)
    expect((await runModelAdapter(adapter, { ...options, mode: 'complete' })).events).toEqual([
      { type: 'done', reason: 'stop' },
    ])
    disposed = false
    const broken = defineModelAdapter({
      ...adapter,
      create(config) {
        return {
          ...adapter.create(config),
          async *stream(): AsyncIterable<never> {
            throw new Error('Wire failure')
          },
        }
      },
    })
    await expect(runModelAdapter(broken, options)).rejects.toThrow('Wire failure')
    expect(disposed).toBe(true)
    disposed = false
    const ac = new AbortController()
    const aborting = defineModelAdapter({
      ...adapter,
      create(config) {
        return {
          ...adapter.create(config),
          async *stream() {
            ac.abort(new Error('Cancelled'))
            yield { type: 'done' as const, reason: 'stop' as const }
          },
        }
      },
    })
    await expect(runModelAdapter(aborting, { ...options, signal: ac.signal })).rejects.toThrow('Cancelled')
    expect(disposed).toBe(true)
    const streamingOnly = defineModelAdapter({
      ...adapter,
      create(config) {
        const { complete: _complete, ...instance } = adapter.create(config)
        return instance
      },
    })
    await expect(runModelAdapter(streamingOnly, { ...options, mode: 'complete' })).rejects.toThrow(
      'does not implement',
    )
  })
})
