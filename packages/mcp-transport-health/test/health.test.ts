import { describe, expect, it, vi } from 'vitest'
import { type CloseObservableTransport, observeTransportDisconnect } from '../src/index.js'

const causes = ['close', 'error'] as const
function emit(transport: CloseObservableTransport, event: (typeof causes)[number], cause: Error): void {
  if (event === 'close') transport.onclose?.()
  else transport.onerror?.(cause)
}

describe('MCP transport health callbacks', () => {
  it('chains SDK callbacks and restores them before intentional disposal', () => {
    const priorClose = vi.fn()
    const priorError = vi.fn()
    const transport = { onclose: priorClose, onerror: priorError }
    const notify = vi.fn()
    const dispose = observeTransportDisconnect(transport, notify)
    const cause = new Error('lost')
    transport.onclose?.()
    transport.onerror?.(cause)
    expect(priorClose).toHaveBeenCalledTimes(1)
    expect(priorError).toHaveBeenCalledExactlyOnceWith(cause)
    expect(notify).toHaveBeenCalledTimes(2)
    dispose()
    dispose()
    transport.onclose?.()
    transport.onerror?.(cause)
    expect(priorClose).toHaveBeenCalledTimes(2)
    expect(priorError).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(transport.onclose).toBe(priorClose)
    expect(transport.onerror).toBe(priorError)
  })

  it.each(causes)('notifies after a throwing SDK %s callback and preserves its error', (event) => {
    const failure = new Error('SDK callback failed')
    const order: string[] = []
    const prior = vi.fn(() => {
      order.push('prior')
      throw failure
    })
    const transport = { onclose: prior, onerror: prior }
    const notify = vi.fn(() => order.push('notify'))
    observeTransportDisconnect(transport, notify)
    expect(() => emit(transport, event, new Error('disconnect'))).toThrow(failure)
    expect(order).toEqual(['prior', 'notify'])
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it.each(causes)('propagates a notify error after the SDK %s callback succeeds', (event) => {
    const failure = new Error('observer failed')
    const prior = vi.fn()
    const transport = { onclose: prior, onerror: prior }
    const notify = vi.fn(() => {
      throw failure
    })
    observeTransportDisconnect(transport, notify)
    expect(() => emit(transport, event, new Error('disconnect'))).toThrow(failure)
    expect(prior).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it.each(causes)('preserves the SDK %s error when notify also throws', (event) => {
    const failure = new Error('SDK callback failed')
    const prior = vi.fn(() => {
      throw failure
    })
    const transport = { onclose: prior, onerror: prior }
    const notify = vi.fn(() => {
      throw new Error('observer failed')
    })
    observeTransportDisconnect(transport, notify)
    expect(() => emit(transport, event, new Error('disconnect'))).toThrow(failure)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('preserves even an undefined thrown by the SDK callback', () => {
    const transport = {
      onclose: () => {
        throw undefined
      },
    }
    const notify = vi.fn(() => {
      throw new Error('observer failed')
    })
    observeTransportDisconnect(transport, notify)
    let caught = false
    try {
      transport.onclose()
    } catch (failure) {
      caught = true
      expect(failure).toBeUndefined()
    }
    expect(caught).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it.each(causes)('does not overwrite a later %s observer while restoring its own callback', (event) => {
    const priorClose = vi.fn()
    const priorError = vi.fn()
    const later = vi.fn()
    const transport = { onclose: priorClose, onerror: priorError }
    const notify = vi.fn()
    const dispose = observeTransportDisconnect(transport, notify)
    if (event === 'close') transport.onclose = later
    else transport.onerror = later
    dispose()
    dispose()
    expect(transport.onclose).toBe(event === 'close' ? later : priorClose)
    expect(transport.onerror).toBe(event === 'error' ? later : priorError)
    emit(transport, event, new Error('intentional shutdown'))
    expect(later).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('supports absent SDK callbacks and does not coalesce error plus close', () => {
    const transport: CloseObservableTransport = {}
    const notify = vi.fn()
    const dispose = observeTransportDisconnect(transport, notify)
    transport.onerror?.(new Error('lost'))
    transport.onclose?.()
    expect(notify).toHaveBeenCalledTimes(2)
    dispose()
    dispose()
    expect(transport.onclose).toBeUndefined()
    expect(transport.onerror).toBeUndefined()
  })
})
