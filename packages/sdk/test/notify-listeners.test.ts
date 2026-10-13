import { describe, expect, it, vi } from 'vitest'
import { Emitter, notifyListeners } from '../src/events.js'

describe('listener notification', () => {
  it('keeps notifying later listeners after one throws, and reports the failure', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const later = vi.fn()
    notifyListeners(
      new Set([
        () => {
          throw new Error('boom')
        },
        later,
      ]),
      'test',
    )
    expect(later).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith('test listener failed:', expect.objectContaining({ message: 'boom' }))
    report.mockRestore()
  })

  it('isolates Emitter handlers the same way', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const emitter = new Emitter<'x'>()
    const later = vi.fn()
    emitter.on('x', () => {
      throw new Error('boom')
    })
    emitter.on('x', later)
    emitter.emit('x', 1)
    expect(later).toHaveBeenCalledWith(1)
    report.mockRestore()
  })
})
