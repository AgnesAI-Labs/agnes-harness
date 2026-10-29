import { afterEach, expect, it, vi } from 'vitest'
import { sidebarGrouping } from '../src/sidebar-grouping.js'

afterEach(() => {
  vi.unstubAllGlobals()
  sidebarGrouping.reset()
})

it('defaults to grouping by workspace and remembers a change', () => {
  expect(sidebarGrouping.getSnapshot()).toBe('workspace')
  const listener = vi.fn()
  const stop = sidebarGrouping.subscribe(listener)
  sidebarGrouping.setGrouping('list')
  expect(sidebarGrouping.getSnapshot()).toBe('list')
  expect(listener).toHaveBeenCalledTimes(1)
  // Choosing the current value again changes nothing, so it notifies nobody.
  sidebarGrouping.setGrouping('list')
  expect(listener).toHaveBeenCalledTimes(1)
  stop()
  sidebarGrouping.setGrouping('workspace')
  expect(listener).toHaveBeenCalledTimes(1)
})

it('reads the stored choice and falls back on a bad value or blocked storage', () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  storage.set('agnes.sidebar.grouping.v1', 'list')
  // The module read the value when it was first imported, so re-import it for a fresh read.
  vi.resetModules()
  return import('../src/sidebar-grouping.js').then((fresh) => {
    expect(fresh.sidebarGrouping.getSnapshot()).toBe('list')
    storage.set('agnes.sidebar.grouping.v1', 'tree')
    fresh.sidebarGrouping.reset()
    expect(fresh.sidebarGrouping.getSnapshot()).toBe('workspace')
    expect(storage.has('agnes.sidebar.grouping.v1')).toBe(false)
  })
})

it('keeps working when local storage throws', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
    removeItem: () => {
      throw new Error('blocked')
    },
  })
  vi.resetModules()
  return import('../src/sidebar-grouping.js').then((fresh) => {
    expect(fresh.sidebarGrouping.getSnapshot()).toBe('workspace')
    fresh.sidebarGrouping.setGrouping('list')
    expect(fresh.sidebarGrouping.getSnapshot()).toBe('list')
    fresh.sidebarGrouping.reset()
    expect(fresh.sidebarGrouping.getSnapshot()).toBe('workspace')
  })
})
