// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindListboxKeys, listboxIntent, positionPopover, positionSubmenu } from '../src/popover.js'

const rect = (height: number, top: number, left: number, width: number): DOMRect =>
  ({
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect

function stubBox(element: HTMLElement, box: DOMRect, scrollHeight?: number): void {
  element.getBoundingClientRect = () => box
  if (scrollHeight !== undefined)
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

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

describe('positionPopover', () => {
  it('judges the flip by content height when the panel is currently clamped shorter', () => {
    // 面板现在被截到 200px、内容要 400px：下方只剩 300px，于是必须翻到上方，
    // 按被截的 200px 判断会以为放得下，结果面板下半截跑到视口外。
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    const trigger = document.createElement('button')
    const panel = document.createElement('section')
    document.body.append(trigger, panel)
    stubBox(trigger, rect(32, 288, 100, 120))
    stubBox(panel, rect(200, 0, 0, 240), 400)

    positionPopover(trigger, panel, { preferredWidth: 240, preferredHeight: 400, viewportPadding: 12 })

    expect(panel.dataset.placement).toBe('above')
    const top = Number.parseFloat(panel.style.top)
    const maxHeight = Number.parseFloat(panel.style.maxHeight)
    // 面板整体落在触发按钮上方，且用满了上方那点空间（268px），不是按被截的 200px 摆。
    expect(top + maxHeight).toBeLessThanOrEqual(288)
    expect(maxHeight).toBe(268)
  })
})

describe('positionSubmenu', () => {
  it('sizes the panel by its content, not by a height it is currently clamped to', () => {
    // 面板被 max-height 截到 200px，内容其实要 400px。位置和高度上限都必须按 400 算，
    // 否则面板只显示前 200px、底下几行落到视口外（或被迫在面板内部滚动）。
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 })
    const anchor = document.createElement('div')
    const parent = document.createElement('div')
    const panel = document.createElement('section')
    document.body.append(anchor, parent, panel)
    stubBox(anchor, rect(40, 560, 120, 240))
    stubBox(parent, rect(300, 100, 100, 240))
    stubBox(panel, rect(200, 0, 0, 240), 400)

    positionSubmenu(anchor, parent, panel, {
      preferredWidth: 240,
      preferredHeight: 600,
      viewportPadding: 12,
    })

    expect(Number.parseFloat(panel.style.maxHeight)).toBeGreaterThanOrEqual(400)
    expect(Number.parseFloat(panel.style.top) + 400).toBeLessThanOrEqual(600)
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
