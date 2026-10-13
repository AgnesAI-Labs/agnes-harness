/** @vitest-environment happy-dom */

import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIDEBAR_SLOT } from '../src/region-slots.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const session = (id: string, cwd: string): PageSessionMeta['items'][number] =>
  ({
    sessionId: id,
    title: `会话 ${id}`,
    cwd,
    archived: false,
    createdAt: '',
    lastSeq: 1,
    generation: 1,
    preset: 'code',
  }) as PageSessionMeta['items'][number]

const workspace = (path: string, name: string): WorkspaceEntry => ({
  path,
  name,
  lastUsedAt: null,
  sessionCount: 1,
  available: true,
})

describe('rendered sidebar region', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it('renders the component-owned navigation, time groups, menus, and actions', async () => {
    const openSession = vi.fn()
    const sessionAction = vi.fn()
    const newSession = vi.fn()
    const addWorkspace = vi.fn()
    const openSettings = vi.fn()
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [session('one', '/workspace')],
          workspaces: [workspace('/workspace', '主工作区')],
          labels: new Map(),
          currentId: 'one',
          sessionPending: false,
          newDisabled: false,
        },
        actions: { openSession, sessionAction, newSession, addWorkspace, openSettings },
      },
    })

    const sidebar = document.querySelector('aside.sidebar')
    expect(sidebar?.querySelector('.brand-wordmark-text')?.textContent).toBe('Agnes Harness')
    // A row without a readable creation time belongs to the last group.
    expect(sidebar?.querySelector('.session-group-label')?.textContent).toBe('Earlier')
    // One registered workspace: naming it on every row would be noise.
    expect(sidebar?.querySelector('.session-workspace')).toBeNull()
    const sessionButton = sidebar?.querySelector<HTMLButtonElement>('[data-session="one"]')
    expect(sessionButton?.getAttribute('aria-current')).toBe('page')
    sessionButton?.click()
    expect(openSession).toHaveBeenCalledWith('one')

    flushSync(() => sidebar?.querySelector<HTMLButtonElement>('.session-menu-trigger')?.click())
    await vi.waitFor(() => expect(document.querySelector('[role=menuitem]')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
    expect(sessionAction).toHaveBeenCalledWith('rename', 'one', '会话 one', expect.any(HTMLElement))
    await vi.waitFor(() =>
      expect(sidebar?.querySelector('.session-menu-trigger')?.getAttribute('aria-expanded')).toBe('false'),
    )
    sidebar?.querySelector<HTMLButtonElement>('#new')?.click()
    sidebar?.querySelector<HTMLButtonElement>('#workspace-add')?.click()
    sidebar?.querySelector<HTMLButtonElement>('#settings')?.click()
    expect(newSession).toHaveBeenCalledOnce()
    expect(addWorkspace).toHaveBeenCalledOnce()
    expect(openSettings).toHaveBeenCalledOnce()
    flushSync(() => sidebar?.querySelector<HTMLButtonElement>('.session-menu-trigger')?.click())
    await vi.waitFor(() =>
      expect(sidebar?.querySelector('.session-menu-trigger')?.getAttribute('aria-expanded')).toBe('true'),
    )
    runtime.sidebar?.update({
      sessions: [session('one', '/workspace')],
      workspaces: [workspace('/workspace', '主工作区')],
      labels: new Map(),
      currentId: 'one',
      sessionPending: true,
      newDisabled: true,
    })
    expect(sidebar?.querySelector<HTMLButtonElement>('.session-menu-trigger')?.disabled).toBe(true)
    expect(sidebar?.querySelector('.session-menu-trigger')?.getAttribute('aria-expanded')).toBe('false')
    expect(sidebar?.querySelector('.session-row')?.hasAttribute('data-menu-open')).toBe(false)
    expect(document.querySelector('[role=menu]')).toBeNull()
  })

  it('marks the running session, shows the shortcut hint and starts a session from the chord', async () => {
    const newSession = vi.fn()
    const state = {
      sessions: [session('one', '/workspace'), session('two', '/workspace')],
      workspaces: [workspace('/workspace', '主工作区')],
      labels: new Map<string, string>(),
      currentId: 'one',
      sessionPending: false,
      newDisabled: false,
    }
    runtime = await mountRenderedIndex({ sidebar: { state, actions: { newSession } } })
    const sidebar = document.querySelector('aside.sidebar')
    expect(sidebar?.querySelector('#new kbd')?.textContent).toMatch(/O$/)
    expect(sidebar?.querySelector('.session-running')).toBeNull()

    flushSync(() => runtime?.sidebar?.setRunning(['two']))
    expect(sidebar?.querySelector('[data-session="two"] .session-running')).not.toBeNull()
    expect(sidebar?.querySelector('[data-session="one"] .session-running')).toBeNull()
    flushSync(() => runtime?.sidebar?.setRunning([]))
    expect(sidebar?.querySelector('.session-running')).toBeNull()

    const chord = () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'O',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    chord()
    expect(newSession).toHaveBeenCalledOnce()
    // A disabled new-session action also ignores the chord.
    runtime.sidebar?.update({ ...state, newDisabled: true })
    chord()
    expect(newSession).toHaveBeenCalledOnce()
  })

  it('groups sessions by the day they were created and refreshes group labels with the locale', async () => {
    const day = (offset: number) => {
      const now = new Date()
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 0, 0, 1).toISOString()
    }
    const state = {
      sessions: [
        { ...session('old', '/workspace'), createdAt: day(9) },
        { ...session('today', '/workspace'), createdAt: day(0) },
        { ...session('yesterday', '/other'), createdAt: day(1) },
        { ...session('archived', '/workspace'), createdAt: day(0), archived: true },
      ],
      workspaces: [workspace('/workspace', '主工作区'), workspace('/other', '另一个')],
      labels: new Map<string, string>(),
      currentId: 'today',
      sessionPending: false,
      newDisabled: false,
      locale: 'en',
    }
    runtime = await mountRenderedIndex({ sidebar: { state } })
    const sidebar = document.querySelector('aside.sidebar')
    const groups = () =>
      [...(sidebar?.querySelectorAll('.session-group') ?? [])].map((group) => [
        group.querySelector('.session-group-label')?.textContent,
        [...group.querySelectorAll<HTMLElement>('[data-session]')].map((row) => row.dataset.session),
      ])
    expect(groups()).toEqual([
      ['Today', ['today']],
      ['Yesterday', ['yesterday']],
      ['Earlier', ['old']],
    ])
    expect(sidebar?.querySelector('[data-session="today"]')?.getAttribute('aria-current')).toBe('page')
    expect(sidebar?.querySelector('.session-row[data-active="true"] [data-session]')).toBe(
      sidebar?.querySelector('[data-session="today"]'),
    )
    // Several workspaces: each row names its own.
    expect(sidebar?.querySelector('[data-session="yesterday"] .session-workspace')?.textContent).toBe(
      '另一个',
    )

    runtime.locale.setLocale('zh-CN')
    runtime.sidebar?.update({ ...state, locale: 'zh-CN' })
    expect(groups().map(([label]) => label)).toEqual(['今天', '昨天', '更早'])
  })

  it('teaches the next step when there is no session yet', async () => {
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [],
          workspaces: [],
          labels: new Map(),
          sessionPending: false,
          newDisabled: false,
        },
      },
    })
    const nav = document.querySelector('aside.sidebar #sessions')
    expect(nav?.querySelector('.session-list-empty h3')?.textContent).toBe('No sessions yet')
    expect(nav?.querySelector('[data-session]')).toBeNull()
  })

  it('keeps keyboard focus on a session row after the navigation rebuilds', async () => {
    const state = {
      sessions: [session('one', '/workspace')],
      workspaces: [workspace('/workspace', '主工作区')],
      labels: new Map<string, string>(),
      currentId: 'one',
      sessionPending: false,
      newDisabled: false,
    }
    runtime = await mountRenderedIndex({ sidebar: { state } })
    const shortcut = () => document.querySelector<HTMLButtonElement>('[data-session="one"]')
    shortcut()?.focus()
    expect(document.activeElement).toBe(shortcut())

    runtime.sidebar?.update({
      ...state,
      sessions: [session('one', '/workspace'), session('two', '/workspace')],
    })
    await new Promise<void>((resolve) => queueMicrotask(resolve))

    expect(document.activeElement).toBe(shortcut())
  })

  // 侧边栏更新挂在事件流上，一次回答期间会被调用数十次，但侧边栏自身的数据多数时候没变。
  // 数据未变时不应重建：重建会丢掉键盘焦点、悬停态与滚动位置。
  it('skips the rebuild while the sidebar data is unchanged', async () => {
    const sidebarState = (
      sessions: PageSessionMeta['items'],
    ): {
      sessions: PageSessionMeta['items']
      workspaces: WorkspaceEntry[]
      labels: Map<string, string>
      currentId: string
      sessionPending: boolean
      newDisabled: boolean
    } => ({
      sessions,
      workspaces: [workspace('/workspace', '主工作区')],
      labels: new Map<string, string>(),
      currentId: 'one',
      sessionPending: false,
      newDisabled: false,
    })

    runtime = await mountRenderedIndex({
      sidebar: { state: sidebarState([session('one', '/workspace')]) },
    })
    const sidebar = document.querySelector('aside.sidebar')
    const before = sidebar?.querySelector('.session-conversations')

    // 等价数据：内容一致，只有对象引用不同（app.ts 每次 update 都会新建外层对象）。
    runtime.sidebar?.update(sidebarState([session('one', '/workspace')]))
    expect(sidebar?.querySelector('.session-conversations')).toBe(before)

    // React reconciles changed rows without discarding the focused navigation subtree.
    runtime.sidebar?.update(sidebarState([session('one', '/workspace'), session('two', '/workspace')]))
    expect(sidebar?.querySelector('.session-conversations')).toBe(before)
    expect(sidebar?.querySelectorAll('.session-row')).toHaveLength(2)
  })

  it('keeps collapsed state and replaces/restores the built-in through a lower-priority shadow', async () => {
    runtime = await mountRenderedIndex()
    const toggle = document.getElementById('sidebar-toggle') as HTMLButtonElement
    toggle.click()
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(true)
    expect((document.querySelector('aside.sidebar') as HTMLElement | null)?.inert).toBe(true)
    toggle.click()
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(false)
    expect((document.querySelector('aside.sidebar') as HTMLElement | null)?.inert).toBe(false)

    const remove = runtime.registry.register(
      { name: SIDEBAR_SLOT as string, id: 'fixture-sidebar-shadow', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'fixture-sidebar-shadow' }, 'shadow sidebar'),
    )
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(document.getElementById('fixture-sidebar-shadow')?.textContent).toBe('shadow sidebar')
    expect(document.getElementById('new')).toBeNull()
    remove()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(document.getElementById('new')).not.toBeNull()
    expect(document.querySelector('[data-agnes-region-unit="sidebar"]')).not.toBeNull()
  })
})
