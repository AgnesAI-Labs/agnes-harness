import { describe, expect, it } from 'vitest'
import { overflowingTabs } from '../src/workbench/tab-fit.js'

describe('workbench tab strip overflow', () => {
  // Files / Changes / Activity record / Terminal at their English widths, 12px apart.
  const widths = [35, 60, 97, 59]

  it('hides nothing when every tab fits or the strip is not laid out yet', () => {
    expect(overflowingTabs(widths, 12, 287, 0)).toEqual([])
    expect(overflowingTabs(widths, 12, 0, 0)).toEqual([])
    expect(overflowingTabs([], 12, 100, -1)).toEqual([])
  })

  it('folds the tab that does not fit and lets a narrower later one keep its place', () => {
    expect(overflowingTabs(widths, 12, 195, 0)).toEqual([2])
    expect(overflowingTabs(widths, 12, 286, 0)).toEqual([3])
  })

  it('always keeps the current tab, folding others to make room for it', () => {
    expect(overflowingTabs(widths, 12, 195, 2)).toEqual([1, 3])
    expect(overflowingTabs(widths, 12, 50, 2)).toEqual([0, 1, 3])
  })
})
