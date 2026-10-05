import { type RuntimeDescriptor, rpcError } from '@agnes/protocol'
import { JsonRpcError } from '@agnes/sdk/browser'
import { describe, expect, it } from 'vitest'
import { RuntimeSelection } from '../src/runtime-selection.js'

const native: RuntimeDescriptor = {
  id: 'native',
  version: '1',
  label: 'Native',
  apiVersion: 1,
  available: true,
  capabilities: { prompt: true, cancel: true, resume: true, compact: true, fork: true },
}

describe('runtime selection', () => {
  it('keeps unavailable choices visible and never substitutes a selected runtime after refresh', async () => {
    const selection = new RuntimeSelection()
    const jev = { ...native, id: 'jevloop', label: 'JevLoop' }
    await selection.refresh({ runtime: { list: async () => ({ items: [native, jev] }) } })
    selection.select('jevloop')
    expect(selection.creation()).toEqual({ runtime: 'jevloop' })
    expect(() => selection.select('external')).toThrow('不可用')
    selection.extensions = () => [
      { id: 'external', label: '扩展目标', available: selection.items.every((runtime) => runtime.available) },
    ]
    selection.select('external')
    expect(selection.available).toBe(true)
    expect(selection.label()).toBe('扩展目标')
    expect(selection.items.map((item) => item.id)).toEqual(['native', 'jevloop'])
    expect(() => selection.creation()).toThrow('客户端模块处理')
    selection.select('jevloop')
    await selection.refresh({
      runtime: {
        list: async () => ({
          items: [native, { ...jev, available: false, unavailableReason: 'Adapter unavailable' }],
        }),
      },
    })
    expect(selection.selected).toBe('jevloop')
    expect(selection.items[1]?.unavailableReason).toBe('Adapter unavailable')
    expect(selection.available).toBe(false)
    expect(() => selection.select('external')).toThrow('不可用')
    expect(() => selection.creation()).toThrow('不可用')
    expect(selection.label({ id: 'native', version: '1' })).toBe('Native · v1')
  })

  it('supports the legacy Native call only for method-not-found and preserves connection errors', async () => {
    const selection = new RuntimeSelection()
    await selection.refresh({
      runtime: {
        list: async () => {
          throw new JsonRpcError(rpcError('METHOD_NOT_FOUND'))
        },
      },
    })
    expect(selection.creation()).toEqual({})
    expect(() => selection.select('jevloop')).toThrow('不可用')
    expect(() => selection.select('external')).toThrow('不可用')
    await expect(
      selection.refresh({
        runtime: {
          list: async () => {
            throw new Error('offline')
          },
        },
      }),
    ).rejects.toThrow('offline')
  })
})
