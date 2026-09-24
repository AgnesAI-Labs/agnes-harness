import { describe, expect, it } from 'vitest'
import {
  normalizeRuntimeError,
  type PluginRuntimeState,
  RuntimeStatusStore,
} from '../src/client-modules/runtime-status.js'

describe('client module runtime status', () => {
  it('publishes bounded state updates and returns an isolated snapshot', () => {
    const store = new RuntimeStatusStore()
    const updates: PluginRuntimeState[] = []
    const off = store.subscribe((state) => updates.push(state))
    const loading: PluginRuntimeState = { packageId: 'pkg-a', revision: 'r1', phase: 'loading' }

    store.set(loading)
    expect(updates).toEqual([loading])
    expect(store.snapshot()).toEqual(new Map([['pkg-a', loading]]))

    const snapshot = store.snapshot()
    ;(snapshot.get('pkg-a') as { phase: string }).phase = 'active'
    expect(store.snapshot().get('pkg-a')?.phase).toBe('loading')

    off()
    store.set({ packageId: 'pkg-a', revision: 'r1', phase: 'active' })
    expect(updates).toHaveLength(1)
  })

  it('normalizes an arbitrary loader error without exposing its details', () => {
    const error = new Error('file:///private/token=secret/index.js\nstack trace')
    const normalized = normalizeRuntimeError('import', error)

    expect(normalized).toEqual({
      code: 'CLIENT_MODULE_IMPORT_FAILED',
      message: '插件 UI 入口加载失败，可重试',
    })
    expect(JSON.stringify(normalized)).not.toContain('secret')
    expect(JSON.stringify(normalized)).not.toContain('private')
  })
})
