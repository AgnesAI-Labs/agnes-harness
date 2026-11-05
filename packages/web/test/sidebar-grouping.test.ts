/** @vitest-environment happy-dom */
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

it('keeps both managed roots as separately named and paged groups', async () => {
  const { sectionViews } = await import('../src/sidebar-rendering.js')
  const { sessionGroupViews, flatLeadingRows, flatMainRows } = await import('../src/sidebar-groups.js')
  const workspaces = [
    {
      path: '/old',
      name: 'old',
      kind: 'chats',
      managedRole: 'legacy',
      workspaceId: 'old-id',
      available: true,
      lastUsedAt: null,
      sessionCount: 1,
    },
    {
      path: '/current',
      name: 'current',
      kind: 'chats',
      managedRole: 'current',
      workspaceId: 'new-id',
      available: true,
      lastUsedAt: null,
      sessionCount: 1,
    },
  ] as const
  const sessions = [
    { sessionId: 'old', cwd: '/old', title: 'old' },
    { sessionId: 'new', cwd: '/current', title: 'new' },
  ]
  const options = { workspaces, sessions } as never
  const groups = sessionGroupViews(options)
  const sections = sectionViews(groups, workspaces, (key) => key)
  expect(sections.map((section) => section.title)).toEqual([
    'sidebar.sectionHeading',
    'nav.chats',
    'nav.legacyChats',
  ])
  expect(sections.filter((s) => s.group).map((s) => s.group?.workspace?.workspaceId)).toEqual([
    'new-id',
    'old-id',
  ])
  expect(flatLeadingRows(sessions as never, workspaces).map((row) => row.sessionId)).toEqual(['old', 'new'])
  expect(flatMainRows(sessions as never, workspaces)).toEqual([])
  const paged = sessionGroupViews({
    workspaces,
    sessions: [],
    paging: {
      groups: [
        { groupId: 'old-id', workspaceId: 'old-id', items: [sessions[0]], total: 8, next: 'old-cursor' },
        { groupId: 'new-id', workspaceId: 'new-id', items: [sessions[1]], total: 2, next: 'new-cursor' },
      ],
    },
  } as never)
  const managed = sectionViews(paged, workspaces, (key) => key).filter((section) => section.group)
  expect(managed.map((section) => [section.group?.id, section.group?.page?.next])).toEqual([
    ['new-id', 'new-cursor'],
    ['old-id', 'old-cursor'],
  ])
})
