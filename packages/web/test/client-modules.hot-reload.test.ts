import { describe, expect, it } from 'vitest'
import { type PluginEventSource, startPluginHotReload } from '../src/client-modules/hot-reload.js'

class FakeEventSource implements PluginEventSource {
  readonly listeners = new Map<string, (event: { data: string }) => void>()
  closed = false
  addEventListener(type: 'graph' | 'rebuilt', listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener)
  }
  removeEventListener(type: 'graph' | 'rebuilt'): void {
    this.listeners.delete(type)
  }
  close(): void {
    this.closed = true
  }
  emit(type: 'graph' | 'rebuilt', data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) })
  }
}

describe('client modules SSE hot reload', () => {
  it('serializes rebuilt events and lets a failed package retry on the next event', async () => {
    let source: FakeEventSource | undefined
    class TestEventSource extends FakeEventSource {
      constructor() {
        super()
        source = this
      }
    }
    const seen: string[] = []
    let rejectFirst = true
    const stop = startPluginHotReload({
      EventSource: TestEventSource,
      reconciler: {
        reconcileNow: async () => undefined,
        invalidate: async () => undefined,
        subscribe: () => () => undefined,
        snapshot: () => new Map(),
        reload: async (id, rev) => {
          seen.push(`${id}@${rev}`)
          if (rejectFirst) {
            rejectFirst = false
            throw new Error('temporary')
          }
        },
      },
      onError: () => undefined,
    })
    if (!source) throw new Error('event source was not constructed')
    source.emit('graph', { type: 'graph' })
    source.emit('rebuilt', { type: 'rebuilt', id: 'a', rev: 'one' })
    source.emit('rebuilt', { type: 'rebuilt', id: 'a', rev: 'two' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual(['a@one', 'a@two'])
    stop()
    expect(source.closed).toBe(true)
  })
})
