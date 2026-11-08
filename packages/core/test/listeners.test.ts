import { describe, expect, it, vi } from 'vitest'
import { Listeners } from '../src/listeners.js'

describe('Listeners', () => {
  it('calls listeners with the emitted arguments until they are removed', () => {
    const listeners = new Listeners<[number]>()
    const fn = vi.fn()
    const off = listeners.on(fn)
    listeners.emit(1)
    off()
    listeners.emit(2)
    expect(fn.mock.calls).toEqual([[1]])
  })

  it('calls a snapshot: changes made by a listener apply to the next emit only', () => {
    const listeners = new Listeners()
    const late = vi.fn()
    const second = vi.fn()
    let offSecond = () => {}
    listeners.on(() => {
      offSecond()
      listeners.on(late)
    })
    offSecond = listeners.on(second)
    listeners.emit()
    expect(second).toHaveBeenCalledTimes(1)
    expect(late).not.toHaveBeenCalled()
    listeners.emit()
    expect(second).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('keeps notifying after a listener throws', () => {
    const listeners = new Listeners()
    const next = vi.fn()
    listeners.on(() => {
      throw new Error('boom')
    })
    listeners.on(next)
    expect(() => listeners.emit()).not.toThrow()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('after emits once the change resolves and returns its result', async () => {
    const listeners = new Listeners()
    const seen: string[] = []
    listeners.on(() => seen.push('emit'))
    const result = listeners.after(
      Promise.resolve().then(() => {
        seen.push('resolved')
        return 7
      }),
    )
    expect(seen).toEqual([])
    expect(await result).toBe(7)
    expect(seen).toEqual(['resolved', 'emit'])
  })

  it('after passes a rejection through without emitting', async () => {
    const listeners = new Listeners()
    const fn = vi.fn()
    listeners.on(fn)
    await expect(listeners.after(Promise.reject(new Error('nope')))).rejects.toThrow('nope')
    expect(fn).not.toHaveBeenCalled()
  })
})
