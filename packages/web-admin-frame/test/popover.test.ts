// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { bindListboxKeys, listboxIntent } from '../src/popover.js'

const key = (value: string): KeyboardEvent => new KeyboardEvent('keydown', { key: value, cancelable: true })

describe('listboxIntent', () => {
  it('maps arrow, home and end to movement', () => {
    expect(listboxIntent(key('ArrowDown'))).toEqual({ kind: 'move', delta: 1 })
    expect(listboxIntent(key('ArrowUp'))).toEqual({ kind: 'move', delta: -1 })
    expect(listboxIntent(key('Home'))).toEqual({ kind: 'first' })
    expect(listboxIntent(key('End'))).toEqual({ kind: 'last' })
  })

  it('treats Enter and Space as activation', () => {
    expect(listboxIntent(key('Enter'))).toEqual({ kind: 'activate' })
    expect(listboxIntent(key(' '))).toEqual({ kind: 'activate' })
  })

  it('dismisses with focus return on Escape and Tab, and ignores everything else', () => {
    expect(listboxIntent(key('Escape'))).toEqual({ kind: 'dismiss', returnFocus: true })
    expect(listboxIntent(key('Tab'))).toEqual({ kind: 'dismiss', returnFocus: true })
    expect(listboxIntent(key('a'))).toBeUndefined()
  })
})

describe('bindListboxKeys', () => {
  it('forwards handled keys and prevents their default so the page never scrolls', () => {
    const listbox = document.createElement('div')
    const handle = vi.fn()
    bindListboxKeys(listbox, handle)

    const down = key('ArrowDown')
    listbox.dispatchEvent(down)
    expect(handle).toHaveBeenCalledWith({ kind: 'move', delta: 1 })
    expect(down.defaultPrevented).toBe(true)

    // Unmapped keys stay with the browser.
    handle.mockClear()
    const other = key('a')
    listbox.dispatchEvent(other)
    expect(handle).not.toHaveBeenCalled()
    expect(other.defaultPrevented).toBe(false)
  })
})
