import { describe, expect, it } from 'vitest'
import {
  buildTraceVirtualLayout,
  captureTraceVirtualAnchor,
  getTraceVirtualScrollTopForKey,
  getTraceVirtualWindow,
  restoreTraceVirtualAnchor,
  type TraceVirtualEntry,
} from '../src/trace-virtual-window.js'

const heights = { header: 32, row: 32 }
const entries = (keys: readonly string[]): TraceVirtualEntry[] =>
  keys.map((key) => ({ key, kind: key.startsWith('turn:') ? 'header' : 'row' }))

describe('trace virtual window', () => {
  it('mounts only visible and overscanned entries while preserving scroll height', () => {
    const layout = buildTraceVirtualLayout(
      entries(['turn:1', ...Array.from({ length: 1000 }, (_, index) => `row:${index}`)]),
      heights,
    )
    const window = getTraceVirtualWindow(layout, 3200, 320, 64)
    expect(window).toEqual({
      start: 98,
      end: 112,
      topPadding: 3136,
      bottomPadding: layout.totalHeight - 3584,
      totalHeight: 1001 * 32,
    })
    expect(window.end - window.start).toBeLessThan(20)
  })

  it('keeps the top visible key and intra-row position after prepend and append', () => {
    const before = buildTraceVirtualLayout(entries(['turn:1', 'a', 'b', 'c']), heights)
    const anchor = captureTraceVirtualAnchor(before, 73)
    expect(anchor).toEqual({ key: 'b', offsetWithinEntry: 9 })

    const prepended = buildTraceVirtualLayout(entries(['turn:0', 'old', 'turn:1', 'a', 'b', 'c']), heights)
    expect(restoreTraceVirtualAnchor(prepended, anchor, 0, 32)).toBe(137)

    const appended = buildTraceVirtualLayout(entries(['turn:1', 'a', 'b', 'c', 'new']), heights)
    expect(restoreTraceVirtualAnchor(appended, anchor, 0, 32)).toBe(73)
  })

  it('reveals a keyed row outside the window and falls back when search removes an anchor', () => {
    const layout = buildTraceVirtualLayout(entries(['turn:1', 'a', 'b', 'c', 'd']), heights)
    expect(getTraceVirtualScrollTopForKey(layout, 'd', 0, 64)).toBe(96)
    expect(getTraceVirtualScrollTopForKey(layout, 'a', 96, 64)).toBe(32)
    expect(getTraceVirtualScrollTopForKey(layout, 'missing', 0, 64)).toBeUndefined()
    expect(getTraceVirtualScrollTopForKey(layout, 'd', 0, 0)).toBe(128)

    const anchor = captureTraceVirtualAnchor(layout, 100)
    const filtered = buildTraceVirtualLayout(entries(['turn:1', 'a']), heights)
    expect(restoreTraceVirtualAnchor(filtered, anchor, 50, 32)).toBe(32)
    expect(getTraceVirtualWindow(filtered, 32, 32)).toEqual({
      start: 1,
      end: 2,
      topPadding: 32,
      bottomPadding: 0,
      totalHeight: 64,
    })
  })

  it('uses separately configured header and row heights', () => {
    const layout = buildTraceVirtualLayout(entries(['turn:1', 'a', 'b']), { header: 40, row: 28 })
    expect(layout.offsets).toEqual([0, 40, 68, 96])
    expect(getTraceVirtualWindow(layout, 35, 30)).toEqual({
      start: 0,
      end: 2,
      topPadding: 0,
      bottomPadding: 28,
      totalHeight: 96,
    })
  })

  it('handles empty lists and rejects unstable geometry', () => {
    const empty = buildTraceVirtualLayout([], heights)
    expect(getTraceVirtualWindow(empty, 0, 100)).toEqual({
      start: 0,
      end: 0,
      topPadding: 0,
      bottomPadding: 0,
      totalHeight: 0,
    })
    expect(captureTraceVirtualAnchor(empty, 0)).toBeUndefined()
    expect(() => buildTraceVirtualLayout(entries(['a', 'a']), heights)).toThrow('duplicate trace key')
    expect(() => buildTraceVirtualLayout(entries(['a']), { header: 32, row: 0 })).toThrow()
  })
})
