/** @vitest-environment happy-dom */

import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import { homeEntries, homeNavigation } from '@agnes/web-client'
import { fireEvent, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { resetCollapsedGroups } from '../src/navigation.js'
import { BUILTIN_HOME_ENTRIES } from '../src/pages/entries.js'
import { SIDEBAR_SLOT } from '../src/region-slots.js'
import { sessionInventory } from '../src/session-inventory.js'
import { sidebarGrouping } from '../src/sidebar-grouping.js'
import { sidebarOrder } from '../src/sidebar-order.js'
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

  /** The view menu is the only way into the archived filter; its items carry stable test ids. */
  const chooseView = async (name: 'archived' | 'active') => {
    document.querySelector<HTMLButtonElement>('#session-view')?.click()
    const item = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-testid="session-view-filter-${name}"]`)
      if (!found) throw new Error('the view menu has not opened yet')
      return found
    })
    item.click()
  }

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
    // 折叠记录与顺序记录是模块级状态并写入本地存储，不清会在用例之间串。
    resetCollapsedGroups()
    sidebarOrder.reset()
    sessionInventory.reset()
    sidebarGrouping.reset()
    vi.unstubAllGlobals()
  })

  it('renders the component-owned navigation, workspace folders, menus, and actions', async () => {
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
          runtimePlatform: 'win32',
          sessionPending: false,
          newDisabled: false,
        },
        actions: { openSession, sessionAction, newSession, addWorkspace, openSettings },
      },
    })

    const sidebar = document.querySelector('aside.sidebar')
    expect(sidebar?.querySelector('.brand-wordmark-text')?.textContent).toBe('Agnes Harness')
    expect(sidebar?.querySelector('.workspace-group.is-nested .workspace-name')?.textContent).toBe('主工作区')
    const sessionButton = sidebar?.querySelector<HTMLButtonElement>('[data-session="one"]')
    expect(sessionButton?.getAttribute('aria-current')).toBe('page')
    sessionButton?.click()
    expect(openSession).toHaveBeenCalledWith('one')

    const heading = sidebar?.querySelector<HTMLButtonElement>('.workspace-group.is-nested .workspace-heading')
    flushSync(() => heading?.click())
    expect((sidebar?.querySelector('.workspace-sessions') as HTMLElement | null)?.hidden).toBe(true)
    flushSync(() => heading?.click())
    expect((sidebar?.querySelector('.workspace-sessions') as HTMLElement | null)?.hidden).toBe(false)

    flushSync(() => sidebar?.querySelector<HTMLButtonElement>('.session-menu-trigger')?.click())
    await vi.waitFor(() => expect(document.querySelector('[role=menuitem]')).not.toBeNull())
    expect([...document.querySelectorAll('[role=menuitem]')].map((item) => item.textContent)).toContain(
      'Show in Explorer',
    )
    getByRole(document.body, 'menuitem', { name: 'Rename' }).click()
    expect(sessionAction).toHaveBeenCalledWith('rename', 'one', '会话 one', expect.any(HTMLElement))
    await vi.waitFor(() =>
      expect(sidebar?.querySelector('.session-menu-trigger')?.getAttribute('aria-expanded')).toBe('false'),
    )
    // 悬停提示由 IconButton 的 Tooltip 提供，原生 title 会再弹一层同样的文案。
    expect(sidebar?.querySelector('#workspace-add')?.getAttribute('title')).toBeNull()
    sidebar?.querySelector<HTMLButtonElement>('#workspace-add')?.click()
    for (const collapsed of [true, false]) {
      document.getElementById('sidebar-toggle')?.click()
      expect(document.body.classList.contains('sidebar-collapsed')).toBe(collapsed)
      // happy-dom does not suppress clicks on inert trees, so assert the browser gate explicitly.
      expect((sidebar as HTMLElement).inert).toBe(false)
      for (const name of ['New conversation', 'Search sessions', 'Settings']) {
        const button = getByRole(sidebar as HTMLElement, 'button', { name })
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
        flushSync(() => button.focus())
        expect(document.activeElement).toBe(button)
        await vi.waitFor(() => {
          const tooltip = document.getElementById(button.getAttribute('aria-describedby') ?? '')
          expect(tooltip?.textContent).toBe(name)
        })
        button.click()
      }
    }
    expect(newSession).toHaveBeenCalledTimes(2)
    expect(addWorkspace).toHaveBeenCalledOnce()
    expect(openSettings).toHaveBeenCalledTimes(2)
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
    // Session admission leaves navigation usable so another selection can supersede it.
    expect(sidebar?.querySelector<HTMLButtonElement>('.session-menu-trigger')?.disabled).toBe(false)
    expect(sidebar?.querySelector('.session-menu-trigger')?.getAttribute('aria-expanded')).toBe('true')
    expect(sidebar?.querySelector('.session-row')?.hasAttribute('data-menu-open')).toBe(true)
    expect(document.querySelector('[role=menu]')).not.toBeNull()
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
    // The shortcut is one keycap per key, ending in O on every platform.
    const caps = [...(sidebar?.querySelectorAll('#new kbd.agh-kbd > .agh-kbd-key') ?? [])]
    expect(caps).toHaveLength(3)
    expect(caps.at(-1)?.textContent).toBe('O')
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

  it('starts a new session in the selected workspace without toggling the folder', async () => {
    const newSession = vi.fn()
    const selectedWorkspace = workspace('/workspace', '主工作区')
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [session('one', selectedWorkspace.path)],
          workspaces: [selectedWorkspace],
          labels: new Map(),
          currentId: 'one',
          sessionPending: false,
          newDisabled: false,
        },
        actions: { newSession },
      },
    })

    const heading = document.querySelector<HTMLButtonElement>('.workspace-group.is-nested .workspace-heading')
    const create = document.querySelector<HTMLButtonElement>('.workspace-new-session')
    expect(create?.getAttribute('aria-label')).toBe('New session in “主工作区”')

    create?.click()

    expect(newSession).toHaveBeenCalledWith(selectedWorkspace)
    expect(heading?.getAttribute('aria-expanded')).toBe('true')
    const menu = document.querySelector<HTMLButtonElement>('.workspace-menu-trigger')
    flushSync(() => menu?.click())
    await vi.waitFor(() => expect(document.querySelector('[role=menuitem]')).not.toBeNull())
    expect([...document.querySelectorAll('[role=menuitem]')].map((item) => item.textContent)).toEqual([
      'New session',
      'Show in File Manager',
      'Remove project…',
    ])
    document.querySelector<HTMLElement>('[role=menuitem]')?.click()
    expect(newSession).toHaveBeenLastCalledWith(selectedWorkspace)
  })

  it('files sessions under their workspace folder, newest first, and follows the locale', async () => {
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
        { ...session('stray', '/removed'), createdAt: day(2) },
      ],
      workspaces: [
        workspace('/workspace', '主工作区'),
        workspace('/other', '另一个'),
        workspace('/empty', '空目录'),
      ],
      labels: new Map<string, string>(),
      currentId: 'today',
      sessionPending: false,
      newDisabled: false,
      locale: 'en',
    }
    runtime = await mountRenderedIndex({ sidebar: { state } })
    const sidebar = document.querySelector('aside.sidebar')
    const folders = () =>
      [...(sidebar?.querySelectorAll('.workspace-group') ?? [])].map((group) => [
        group.querySelector('.workspace-name')?.textContent,
        [...group.querySelectorAll<HTMLElement>('[data-session]')].map((row) => row.dataset.session),
      ])
    // A registered workspace keeps its folder while empty; a session whose folder is gone is unassigned.
    expect(folders()).toEqual([
      ['主工作区', ['today', 'old']],
      ['另一个', ['yesterday']],
      ['空目录', []],
      ['Unassigned', ['stray']],
    ])
    expect(sidebar?.querySelector('[data-session="today"]')?.getAttribute('aria-current')).toBe('page')
    expect(sidebar?.querySelector('.session-row[data-active="true"] [data-session]')).toBe(
      sidebar?.querySelector('[data-session="today"]'),
    )
    // The folder says which workspace a row belongs to; rows do not repeat it.
    expect(sidebar?.querySelector('[data-session="yesterday"] .session-title')?.textContent).toBe(
      '会话 yesterday',
    )
    expect(sidebar?.querySelector('[data-session="yesterday"] .session-workspace-label')).toBeNull()
    // The row end shows when the session last moved, in the list's short form.
    expect(sidebar?.querySelector('[data-session="yesterday"] .session-time')?.textContent).toBe('Yesterday')
    const shortcuts = () => sidebar?.querySelectorAll<HTMLButtonElement>('.workspace-new-session')
    expect(shortcuts()).toHaveLength(3)
    expect(shortcuts()?.[1]?.getAttribute('aria-label')).toBe('New session in “另一个”')

    runtime.locale.setLocale('zh-CN')
    runtime.sidebar?.update({ ...state, locale: 'zh-CN' })
    expect(folders().at(-1)?.[0]).toBe('未分类')
    expect(shortcuts()?.[1]?.getAttribute('aria-label')).toBe('在“另一个”中新建会话')
  })

  it('renders 置顶, 项目 and 临时会话 as peer sections in that fixed order, tools on their headings', async () => {
    const chats: WorkspaceEntry = { ...workspace('/chats', 'chats'), kind: 'chats' }
    const addWorkspace = vi.fn()
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [
            { ...session('pinned', '/workspace'), pinnedAt: '2026-10-20T08:00:00.000Z' },
            session('chat', '/chats'),
            session('one', '/workspace'),
          ],
          workspaces: [workspace('/workspace', '主工作区'), chats],
          labels: new Map(),
          sessionPending: false,
          newDisabled: false,
        },
        actions: { addWorkspace },
      },
    })
    const sidebar = document.querySelector<HTMLElement>('aside.sidebar')
    const nav = sidebar?.querySelector<HTMLElement>('#sessions')
    if (!sidebar || !nav) throw new Error('missing sidebar structure')
    // 分组视图把三个分区放进列表，前置槽位不再另起一份完整列表，外壳也不再打印标题行。
    expect(sidebar.querySelector('.sidebar-leading')).toBeNull()
    expect(sidebar.querySelector('.sidebar-section-heading')).toBeNull()
    const sections = [...nav.querySelectorAll<HTMLElement>('.sidebar-section')]
    expect(sections.map((section) => section.dataset.section)).toEqual(['pinned', 'workspaces', 'chats'])
    const headings = [
      ...nav.querySelectorAll<HTMLElement>('.sidebar-section > .workspace-heading-row .workspace-heading'),
    ]
    expect(headings.map((node) => node.querySelector('.workspace-name')?.textContent)).toEqual([
      'Pinned',
      'Projects',
      'Chats',
    ])
    // 每个分区标题都是真正的折叠按钮，标题后一个小箭头表达展开/收起。
    for (const heading of headings) {
      expect(heading.tagName).toBe('BUTTON')
      expect(heading.getAttribute('aria-expanded')).toBe('true')
      expect(heading.querySelector('.workspace-chevron')).not.toBeNull()
    }
    expect(
      [...nav.querySelectorAll('.workspace-group .workspace-name')].map((node) => node.textContent),
    ).toEqual(['主工作区'])
    // 视图选项与「打开项目文件夹」挂在「项目」标题上；顶部那排悬浮图标不复存在。
    const projectTools = nav.querySelector<HTMLElement>('[data-section="workspaces"] .sidebar-section-tools')
    expect([...(projectTools?.querySelectorAll('button') ?? [])].map((button) => button.id)).toEqual([
      'session-view',
      'workspace-add',
    ])
    expect(projectTools?.querySelector('#workspace-add')?.getAttribute('aria-label')).toBe(
      'Open project folder',
    )
    projectTools?.querySelector<HTMLButtonElement>('#workspace-add')?.click()
    expect(addWorkspace).toHaveBeenCalledOnce()
    // 「临时会话」标题保留它自己的新建按钮；「置顶」标题没有工具。
    expect(
      nav.querySelector('[data-section="chats"] > .workspace-heading-row .workspace-new-session'),
    ).not.toBeNull()
    expect(nav.querySelector('[data-section="pinned"] > .workspace-heading-row button + *')).toBeNull()
    // 搜索是新会话与首页入口下方的一整条输入式按钮，位于会话列表之前。
    const search = sidebar.querySelector<HTMLElement>('.sidebar-search #session-search')
    expect(search?.textContent).toContain('Search sessions')
    expect((search?.compareDocumentPosition(nav) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 项目行带会话数。
    expect(nav.querySelector('.workspace-group.is-nested .workspace-count')?.textContent).toBe('1')
  })

  it('folds a section from its heading and remembers it across a reload', async () => {
    const chats: WorkspaceEntry = { ...workspace('/chats', 'chats'), kind: 'chats' }
    const state = {
      sessions: [session('chat', '/chats'), session('one', '/workspace')],
      workspaces: [workspace('/workspace', '主工作区'), chats],
      labels: new Map<string, string>(),
      sessionPending: false,
      newDisabled: false,
    }
    runtime = await mountRenderedIndex({ sidebar: { state } })
    const heading = () =>
      document.querySelector<HTMLButtonElement>(
        '[data-section="chats"] > .workspace-heading-row .workspace-heading',
      )
    const body = () => document.querySelector<HTMLElement>('#sidebar-section-chats')
    flushSync(() => heading()?.click())
    expect(heading()?.getAttribute('aria-expanded')).toBe('false')
    expect(body()?.hidden).toBe(true)
    // 其余分区不受影响。
    expect(document.querySelector<HTMLElement>('#sidebar-section-workspaces')?.hidden).toBe(false)
    await runtime.dispose()
    resetWebDom()
    runtime = await mountRenderedIndex({ sidebar: { state } })
    expect(heading()?.getAttribute('aria-expanded')).toBe('false')
    expect(body()?.hidden).toBe(true)
    flushSync(() => heading()?.click())
    expect(body()?.hidden).toBe(false)
  })

  it('says one thing at a row end: running, then waiting, then the last activity time', async () => {
    // Pin local noon: three hours earlier must stay today, or the row end says "Yesterday".
    const today = new Date()
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12),
    })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const recent = new Date(Date.now() - 3 * 3_600_000).toISOString()
    const at = (id: string, cwd = '/workspace') => ({ ...session(id, cwd), lastMessageAt: recent })
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          // Five rows per project show before 「显示更多」, so the quiet row lives in its own project.
          sessions: [
            at('current'),
            at('running'),
            at('approval'),
            at('question'),
            at('done'),
            at('idle', '/other'),
          ],
          workspaces: [workspace('/workspace', '主工作区'), workspace('/other', '另一个')],
          labels: new Map(),
          currentId: 'current',
          sessionPending: false,
          newDisabled: false,
          locale: 'en',
        },
      },
    })
    flushSync(() => {
      runtime?.sidebar?.setRunning(['running', 'current'])
      runtime?.sidebar?.setMarks({
        running: 'approval',
        approval: 'approval',
        question: 'question',
        done: 'completed',
      })
    })
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-session="${id}"]`)
    const end = (id: string) => row(id)?.dataset.status
    // A running turn outranks a waiting mark on the same row.
    expect(end('running')).toBe('running')
    expect(row('running')?.querySelector('.session-running')?.getAttribute('aria-label')).toBe('Running')
    expect(row('running')?.querySelector('.session-mark')).toBeNull()
    expect(end('approval')).toBe('waiting')
    expect(row('approval')?.querySelector('.session-mark')?.textContent).toBe('Needs approval')
    expect(row('question')?.querySelector('.session-mark')?.textContent).toBe('Needs answer')
    // A finished turn nobody has seen is a dot before the title; the row end still tells the time.
    expect(row('done')?.querySelector('.session-unread + .session-title')).not.toBeNull()
    expect(row('done')?.querySelector('.session-unread')?.getAttribute('aria-label')).toBe('Done')
    expect(end('done')).toBe('time')
    expect(row('idle')?.querySelector('.session-time')?.textContent).toBe('3h')
    expect(row('idle')?.querySelector('.session-unread')).toBeNull()
    // The open session is a selected row: medium-weight title, no card.
    expect(row('current')?.closest('.session-row')?.getAttribute('data-active')).toBe('true')
    expect(row('current')?.classList.contains('active')).toBe(true)
    expect(end('current')).toBe('running')
  })

  it('keeps the leading area above the 「会话」 heading in single-list mode', async () => {
    sidebarGrouping.setGrouping('list')
    const chats: WorkspaceEntry = { ...workspace('/chats', 'chats'), kind: 'chats' }
    sessionInventory.bind({
      list: async () => ({
        items: [
          { ...session('pinned', '/workspace'), pinnedAt: '2026-10-20T08:00:00.000Z' },
          session('chat', '/chats'),
          session('one', '/workspace'),
        ],
      }),
      restore: vi.fn(),
      changed: async () => undefined,
    })
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [session('one', '/workspace')],
          workspaces: [workspace('/workspace', '主工作区'), chats],
          labels: new Map(),
          sessionPending: false,
          newDisabled: false,
        },
      },
    })
    const sidebar = document.querySelector<HTMLElement>('aside.sidebar')
    if (!sidebar) throw new Error('missing sidebar')
    await vi.waitFor(() => expect(sidebar.querySelector('[data-session="one"]')).not.toBeNull())
    expect(sidebar.querySelector('.sidebar-section-heading .section-label')?.textContent).toBe('Sessions')
    const leading = sidebar.querySelector<HTMLElement>('.sidebar-leading')
    const heading = sidebar.querySelector<HTMLElement>('.sidebar-section-heading')
    const nav = sidebar.querySelector<HTMLElement>('#sessions')
    if (!leading || !heading || !nav) throw new Error('missing sidebar structure')
    expect(leading.querySelector('[data-session="pinned"]')).not.toBeNull()
    expect(leading.querySelector('[data-session="chat"]')).not.toBeNull()
    expect(nav.querySelector('[data-session="one"]')).not.toBeNull()
    expect(nav.querySelector('[data-session="pinned"]')).toBeNull()
    expect((leading.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
  })

  it('disables unavailable workspace shortcuts and omits one for unassigned sessions', async () => {
    const unavailable = { ...workspace('/workspace', '不可用工作区'), available: false }
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [session('one', '/unassigned')],
          workspaces: [unavailable],
          labels: new Map(),
          sessionPending: false,
          newDisabled: false,
        },
      },
    })

    const shortcuts = document.querySelectorAll<HTMLButtonElement>('.workspace-new-session')
    expect(shortcuts).toHaveLength(1)
    expect(shortcuts[0]?.disabled).toBe(true)

    runtime.sidebar?.update({
      sessions: [session('one', '/unassigned')],
      workspaces: [{ ...unavailable, available: true }],
      labels: new Map(),
      sessionPending: false,
      newDisabled: true,
    })
    expect(document.querySelector<HTMLButtonElement>('.workspace-new-session')?.disabled).toBe(true)
  })

  // 回归：导航区随状态更新重绘，折叠态必须活过重绘，也要活过重新加载（本地存储）。
  it('keeps a collapsed workspace folder across a rebuild and a reload', async () => {
    const state = {
      sessions: [session('one', '/workspace')],
      workspaces: [workspace('/workspace', '主工作区')],
      labels: new Map<string, string>(),
      currentId: 'one',
      sessionPending: false,
      newDisabled: false,
    }
    runtime = await mountRenderedIndex({ sidebar: { state } })

    const sidebar = document.querySelector('aside.sidebar')
    const heading = () =>
      sidebar?.querySelector<HTMLButtonElement>('.workspace-group.is-nested .workspace-heading')
    const children = () =>
      sidebar?.querySelector('.workspace-group .workspace-sessions') as HTMLElement | null

    flushSync(() => heading()?.click())
    expect(children()?.hidden).toBe(true)
    expect(heading()?.getAttribute('aria-expanded')).toBe('false')
    expect(JSON.parse(localStorage.getItem('agnes.sidebar.collapsed-workspaces.v1') ?? '[]')).toEqual([
      '/workspace',
    ])

    // 数据真的变了（新会话入列）⇒ 导航区必然重绘，折叠态必须活下来。
    runtime.sidebar?.update({
      ...state,
      sessions: [session('one', '/workspace'), session('two', '/workspace')],
    })

    expect(children()?.hidden).toBe(true)
    expect(heading()?.getAttribute('aria-expanded')).toBe('false')

    // 收起状态不得变成「点不开」：再点一次应当恢复展开。
    flushSync(() => heading()?.click())
    expect(children()?.hidden).toBe(false)
    expect(JSON.parse(localStorage.getItem('agnes.sidebar.collapsed-workspaces.v1') ?? '[]')).toEqual([])
  })

  it('keeps the sections fixed and reorders projects by pointer and keyboard, announcing the result', async () => {
    const chats: WorkspaceEntry = { ...workspace('/chats', 'chats'), kind: 'chats' }
    // An order saved by an older build that let sections move is ignored.
    localStorage.setItem('agnes.sidebar.section-order.v1', JSON.stringify(['chats', 'workspaces', 'pinned']))
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [
            { ...session('pinned', '/workspace'), pinnedAt: '2026-10-20T08:00:00.000Z' },
            session('chat', '/chats'),
            session('one', '/workspace'),
            session('two', '/other'),
          ],
          workspaces: [workspace('/workspace', '主工作区'), workspace('/other', '另一个'), chats],
          labels: new Map(),
          sessionPending: false,
          newDisabled: false,
        },
      },
    })
    const sidebar = document.querySelector<HTMLElement>('aside.sidebar')
    if (!sidebar) throw new Error('missing sidebar')
    const order = () =>
      [...sidebar.querySelectorAll<HTMLElement>('#sessions > .sidebar-section')].map(
        (section) => section.dataset.section,
      )
    const sectionRow = (id: string) =>
      sidebar.querySelector<HTMLElement>(`[data-section="${id}"] > .workspace-heading-row`)
    const sectionHeading = (id: string) =>
      sidebar.querySelector<HTMLElement>(`[data-section="${id}"] > .workspace-heading-row .workspace-heading`)
    const transfer = { setData: vi.fn(), getData: vi.fn(() => ''), effectAllowed: '', dropEffect: '' }
    // `fireEvent` from @testing-library/dom does not wrap React's act, so flush each step before
    // the next handler reads the drag state it depends on.
    const drag = (handle: HTMLElement, target: HTMLElement) => {
      fireEvent.dragStart(handle, { dataTransfer: transfer })
      flushSync(() => {})
      fireEvent.dragOver(target, { dataTransfer: transfer, clientY: 10 })
      flushSync(() => {})
      fireEvent.drop(target, { dataTransfer: transfer, clientY: 10 })
      flushSync(() => {})
    }

    const announced = () =>
      sidebar.querySelector('.visually-hidden[role="status"][aria-live="polite"]')?.textContent
    expect(order()).toEqual(['pinned', 'workspaces', 'chats'])
    // Section headings are fold buttons only: not draggable, no Alt+Arrow move.
    for (const id of ['pinned', 'workspaces', 'chats']) {
      expect(sectionHeading(id)?.hasAttribute('draggable')).toBe(false)
      expect(sectionHeading(id)?.hasAttribute('aria-keyshortcuts')).toBe(false)
    }
    drag(sectionHeading('pinned') as HTMLElement, sectionRow('chats') as HTMLElement)
    fireEvent.keyDown(sectionHeading('chats') as HTMLElement, { key: 'ArrowUp', altKey: true })
    flushSync(() => {})
    expect(order()).toEqual(['pinned', 'workspaces', 'chats'])
    expect(announced()).toBe('')

    // Projects move only inside 项目, and their headings say so.
    const groups = () =>
      [...sidebar.querySelectorAll('.workspace-group.is-nested .workspace-name')].map(
        (node) => node.textContent,
      )
    const groupNamed = (name: string) =>
      [...sidebar.querySelectorAll<HTMLElement>('.workspace-group.is-nested')].find(
        (group) => group.querySelector('.workspace-name')?.textContent === name,
      )
    expect(groups()).toEqual(['主工作区', '另一个'])
    const first = groupNamed('主工作区') as HTMLElement
    const second = groupNamed('另一个') as HTMLElement
    expect(first.querySelector('.workspace-heading')?.getAttribute('draggable')).toBe('true')
    expect(first.querySelector('.workspace-heading')?.getAttribute('aria-keyshortcuts')).toBe(
      'Alt+ArrowUp Alt+ArrowDown',
    )
    drag(
      first.querySelector<HTMLElement>('.workspace-heading') as HTMLElement,
      second.querySelector<HTMLElement>('.workspace-heading-row') as HTMLElement,
    )
    expect(groups()).toEqual(['另一个', '主工作区'])
    // The announcement names the row that moved, not the row it landed on.
    expect(announced()).toBe('主工作区 moved to position 2')
    expect(JSON.parse(localStorage.getItem('agnes.sidebar.workspace-order.v1') ?? '[]')).toEqual([
      '/other',
      '/workspace',
    ])
    fireEvent.keyDown(
      groupNamed('主工作区')?.querySelector<HTMLElement>('.workspace-heading') as HTMLElement,
      { key: 'ArrowUp', altKey: true },
    )
    flushSync(() => {})
    expect(groups()).toEqual(['主工作区', '另一个'])
    expect(announced()).toBe('主工作区 moved to position 1')
    expect(order()).toEqual(['pinned', 'workspaces', 'chats'])
  })

  it('teaches the next step when there is no session yet', async () => {
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [],
          workspaces: [workspace('/workspace', '主工作区')],
          labels: new Map(),
          sessionPending: false,
          newDisabled: false,
        },
      },
    })
    const nav = document.querySelector('aside.sidebar #sessions')
    // The folder stays so a session can be started in it; the empty state explains the list.
    expect(nav?.querySelector('.workspace-group .workspace-name')?.textContent).toBe('主工作区')
    expect(nav?.querySelector('.session-list-empty h3')?.textContent).toBe('No sessions yet')
    expect(nav?.querySelector('[data-session]')).toBeNull()
  })

  it('restores keyboard focus to a workspace shortcut after the navigation rebuilds', async () => {
    const state = {
      sessions: [session('one', '/workspace')],
      workspaces: [workspace('/workspace', '主工作区')],
      labels: new Map<string, string>(),
      currentId: 'one',
      sessionPending: false,
      newDisabled: false,
    }
    runtime = await mountRenderedIndex({ sidebar: { state } })
    const shortcut = () => document.querySelector<HTMLButtonElement>('.workspace-new-session')
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
    const before = sidebar?.querySelector('.workspace-sessions')

    // 等价数据：内容一致，只有对象引用不同（app.ts 每次 update 都会新建外层对象）。
    runtime.sidebar?.update(sidebarState([session('one', '/workspace')]))
    expect(sidebar?.querySelector('.workspace-sessions')).toBe(before)

    // React reconciles changed rows without discarding the focused navigation subtree.
    runtime.sidebar?.update(sidebarState([session('one', '/workspace'), session('two', '/workspace')]))
    expect(sidebar?.querySelector('.workspace-sessions')).toBe(before)
    expect(sidebar?.querySelectorAll('.session-row')).toHaveLength(2)
  })

  it('keeps collapsed state and replaces/restores the built-in through a lower-priority shadow', async () => {
    runtime = await mountRenderedIndex()
    const toggle = document.getElementById('sidebar-toggle') as HTMLButtonElement
    toggle.click()
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(true)
    expect((document.querySelector('aside.sidebar') as HTMLElement | null)?.inert).toBe(false)
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
  it('lists the built-in home entries first, opens the selected page and drops a disposed entry', async () => {
    const page = () => null
    const disposers = [
      // Primary placement keeps built-ins first even when a secondary has a lower order.
      homeEntries.register({
        id: 'example.board',
        order: 1,
        icon: 'no-such-icon',
        titleKey: 'Board',
        component: page,
      }),
      ...[...BUILTIN_HOME_ENTRIES].reverse().map((id, index) =>
        homeEntries.register({
          id,
          order: 30 - index * 10,
          placement: 'primary',
          icon: 'plug',
          titleKey: `home.entry.${id}`,
          ...(id === 'plugins' ? { badge: { getSnapshot: () => 2, subscribe: () => () => {} } } : {}),
          component: page,
        }),
      ),
      homeEntries.register({
        id: 'primary.board',
        order: 40,
        placement: 'primary',
        icon: 'puzzle',
        titleKey: 'Primary board',
        component: page,
      }),
    ]
    try {
      runtime = await mountRenderedIndex({
        sidebar: {
          state: {
            sessions: [session('one', '/workspace')],
            workspaces: [workspace('/workspace', '主工作区')],
            labels: new Map(),
            sessionPending: false,
            newDisabled: false,
          },
        },
      })
      const sidebar = document.querySelector('aside.sidebar')
      const ids = () =>
        [...(sidebar?.querySelectorAll('[data-testid^="home-entry-"]') ?? [])].map((entry) =>
          entry.getAttribute('data-testid'),
        )
      // Built-in pages stay above workspaces in their navigation order.
      const agents = sidebar?.querySelector('[data-testid="home-entry-agents"]')
      expect(agents?.querySelector('.home-entry-label')?.firstChild?.textContent).toBe('Agents')
      expect(ids()).toEqual([
        'home-entry-plugins',
        'home-entry-agents',
        'home-entry-automation',
        'home-entry-primary.board',
        'home-entry-example.board',
      ])
      expect(
        sidebar?.querySelector('[data-testid="home-entry-plugins"]')?.closest('.sidebar-footer'),
      ).toBeNull()
      expect(sidebar?.querySelectorAll('.sidebar-footer .home-entry')).toHaveLength(0)
      expect(agents?.closest('.sidebar-footer')).toBeNull()
      expect(
        sidebar?.querySelector('[data-testid="home-entry-plugins"] .home-entry-badge')?.textContent,
      ).toContain('2')
      // The entries sit between the new-session action and the workspace list.
      const entries = sidebar?.querySelector('[data-testid="home-entries"]')
      expect(
        (sidebar?.querySelector('#new')?.compareDocumentPosition(entries as Node) ?? 0) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      expect(
        (entries?.compareDocumentPosition(sidebar?.querySelector('#sessions') as Node) ?? 0) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      for (const collapsed of [true, false]) {
        document.getElementById('sidebar-toggle')?.click()
        expect(document.body.classList.contains('sidebar-collapsed')).toBe(collapsed)
        expect((sidebar as HTMLElement).inert).toBe(false)
        for (const id of BUILTIN_HOME_ENTRIES) {
          const title = runtime.locale.t(`home.entry.${id}`)
          const name = title
          const button = getByRole(sidebar as HTMLElement, 'button', { name })
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
          flushSync(() => button.focus())
          expect(document.activeElement).toBe(button)
          await vi.waitFor(() => {
            const tooltip = document.getElementById(button.getAttribute('aria-describedby') ?? '')
            expect(tooltip?.textContent).toBe(name)
          })
          flushSync(() => button.click())
          expect(homeNavigation.getSnapshot()).toEqual({ id })
          expect(sidebar?.querySelectorAll('.home-entry[aria-current="page"]')).toHaveLength(1)
          expect(button.getAttribute('aria-current')).toBe('page')
        }
        flushSync(() => homeNavigation.close())
        expect(sidebar?.querySelector('.home-entry[aria-current="page"]')).toBeNull()
      }
      // The overflow entry keeps its menu keyboard contract when wrapped in a tooltip.
      flushSync(() => {
        for (let index = 0; index < 3; index++) {
          disposers.push(
            homeEntries.register({
              id: `example.extra-${index}`,
              order: 40 + index,
              icon: 'puzzle',
              titleKey: `Extra ${index}`,
              component: page,
            }),
          )
        }
      })
      expect(ids()).toContain('home-entry-primary.board')
      const more = getByRole(sidebar as HTMLElement, 'button', { name: runtime.locale.t('home.entry.more') })
      expect(more.getAttribute('aria-haspopup')).toBe('menu')
      flushSync(() => more.focus())
      flushSync(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
      await vi.waitFor(() => expect(getByRole(document.body, 'menuitem', { name: 'Board' })).toBeTruthy())
      flushSync(() => getByRole(document.body, 'menuitem', { name: 'Board' }).click())
      expect(homeNavigation.getSnapshot()).toEqual({ id: 'example.board' })
      flushSync(() => disposers[0]?.())
      expect(ids()).not.toContain('home-entry-example.board')
    } finally {
      homeNavigation.close()
      for (const dispose of disposers) dispose()
    }
  })

  it('inerts only the off-screen narrow drawer and resyncs when the viewport changes', async () => {
    const media = window.matchMedia('(max-width: 900px)')
    let narrow = true
    Object.defineProperty(media, 'matches', { get: () => narrow })
    const matchMedia = window.matchMedia.bind(window)
    vi.stubGlobal('matchMedia', (query: string) =>
      query === '(max-width: 900px)' ? media : matchMedia(query),
    )
    const openSettings = vi.fn()
    runtime = await mountRenderedIndex({ sidebar: { actions: { openSettings } } })
    const sidebar = document.querySelector<HTMLElement>('aside.sidebar') as HTMLElement
    const main = document.querySelector('main') as HTMLElement
    expect(sidebar.inert).toBe(true)
    document.getElementById('sidebar-toggle')?.click()
    expect(sidebar.inert).toBe(false)
    expect(main.inert).toBe(true)
    getByRole(sidebar, 'button', { name: 'Settings' }).click()
    expect(openSettings).toHaveBeenCalledOnce()
    expect(document.getElementById('sidebar-close')?.getAttribute('title')).toBeNull()
    document.getElementById('sidebar-close')?.click()
    expect(sidebar.inert).toBe(true)
    expect(main.inert).toBe(false)
    document.body.classList.add('sidebar-collapsed')
    narrow = false
    media.dispatchEvent(new Event('change'))
    expect(sidebar.inert).toBe(false)
    expect(main.inert).toBe(false)
    narrow = true
    media.dispatchEvent(new Event('change'))
    expect(sidebar.inert).toBe(true)
  })

  it('switches the list to archived sessions from the heading switch and restores one', async () => {
    const archived = { ...session('old', '/workspace'), archived: true }
    const restore = vi.fn().mockResolvedValue(undefined)
    sessionInventory.bind({
      list: async () => ({ items: [archived, session('one', '/workspace')] }),
      restore,
      changed: async () => undefined,
    })
    try {
      runtime = await mountRenderedIndex({
        sidebar: {
          state: {
            sessions: [session('one', '/workspace'), archived],
            workspaces: [workspace('/workspace', '主工作区')],
            labels: new Map(),
            sessionPending: false,
            newDisabled: false,
          },
        },
      })
      const sidebar = document.querySelector('aside.sidebar')
      expect(sidebar?.querySelector('[data-session="old"]')).toBeNull()
      expect(sidebar?.querySelector('#session-search')).not.toBeNull()
      // 归档入口已移出列表，也没有标题行快捷按钮：筛选只从视图菜单进入。
      expect(sidebar?.querySelector('[data-testid="sidebar-view-row"]')).toBeNull()
      expect(sidebar?.querySelector('#session-archive')).toBeNull()

      await chooseView('archived')
      // 行本身是 Conversations 的 li；`data-session` 在内层按钮上。
      await vi.waitFor(() => expect(sidebar?.querySelector('[data-session="old"]')).not.toBeNull())
      // 归档视图由完整清单渲染；未归档会话不在其中。
      expect(sidebar?.querySelector('[data-testid="session-inventory"]')).not.toBeNull()
      expect(sidebar?.querySelector('[data-session="one"]')).toBeNull()
      sidebar?.querySelector<HTMLButtonElement>('[data-testid="archived-restore"]')?.click()
      await vi.waitFor(() => expect(sidebar?.querySelector('[data-session="old"]')).toBeNull())
      expect(restore).toHaveBeenCalledWith('old')

      await chooseView('active')
      await vi.waitFor(() => expect(sidebar?.querySelector('[data-testid="session-inventory"]')).toBeNull())
      expect(sidebar?.querySelector('[data-session="one"]')).not.toBeNull()
    } finally {
      sessionInventory.reset()
    }
  })

  it('opens an archived session from its row and marks it current without leaving the filter', async () => {
    const archived = { ...session('old', '/workspace'), archived: true }
    const openSession = vi.fn()
    let finish!: (page: { items: PageSessionMeta['items'] }) => void
    sessionInventory.bind({
      list: () =>
        new Promise<{ items: PageSessionMeta['items'] }>((resolve) => {
          finish = resolve
        }),
      restore: vi.fn(),
      changed: async () => undefined,
    })
    try {
      runtime = await mountRenderedIndex({
        sidebar: {
          state: {
            sessions: [archived],
            workspaces: [workspace('/workspace', '主工作区')],
            labels: new Map(),
            currentId: 'old',
            sessionPending: false,
            newDisabled: false,
          },
          actions: { openSession },
        },
      })
      const sidebar = document.querySelector('aside.sidebar')
      await chooseView('archived')
      // 首次读取尚未返回时用一行状态文案占位，避免列表空白。
      await vi.waitFor(() =>
        expect(sidebar?.querySelector('.sidebar-inventory-loading')?.textContent).toBe(
          'Reading archived sessions…',
        ),
      )
      finish({ items: [archived] })
      const open = await vi.waitFor(() => {
        const found = sidebar?.querySelector<HTMLButtonElement>('[data-session="old"]')
        if (!found) throw new Error('the archived row has not rendered yet')
        return found
      })
      const row = open.closest('.session-row')
      expect(row?.getAttribute('data-active')).toBe('true')
      expect(row?.getAttribute('data-archived')).toBe('true')
      expect(open?.getAttribute('aria-current')).toBe('page')
      open?.click()
      expect(openSession).toHaveBeenCalledWith('old')
      // 打开会话不退出归档筛选：仓库仍停在归档模式。
      expect(sessionInventory.getSnapshot().mode).toBe('archived')
    } finally {
      sessionInventory.reset()
    }
  })

  it('keeps the row and writes no inline error when restoring fails', async () => {
    const archived = { ...session('old', '/workspace'), archived: true }
    const error = vi.fn()
    sessionInventory.bind({
      list: async () => ({ items: [archived] }),
      restore: vi.fn().mockRejectedValue(new Error('daemon offline')),
      changed: async () => undefined,
      error,
    })
    try {
      runtime = await mountRenderedIndex({
        sidebar: {
          state: {
            sessions: [archived],
            workspaces: [workspace('/workspace', '主工作区')],
            labels: new Map(),
            sessionPending: false,
            newDisabled: false,
          },
        },
      })
      const sidebar = document.querySelector('aside.sidebar')
      await chooseView('archived')
      // 行本身是 Conversations 的 li；`data-session` 在内层按钮上。
      await vi.waitFor(() => expect(sidebar?.querySelector('[data-session="old"]')).not.toBeNull())
      sidebar?.querySelector<HTMLButtonElement>('[data-testid="archived-restore"]')?.click()
      await vi.waitFor(() => expect(error).toHaveBeenCalled())
      // 恢复失败只走应用通知：行保留，列表里不出现内联红字与重试。
      expect(sidebar?.querySelector('[data-session="old"]')).not.toBeNull()
      expect(sidebar?.querySelector('.sidebar-inventory [role="alert"]')).toBeNull()
    } finally {
      sessionInventory.reset()
    }
  })
})

describe('long session titles', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
    resetCollapsedGroups()
    sidebarOrder.reset()
    sessionInventory.reset()
    sidebarGrouping.reset()
    vi.unstubAllGlobals()
  })

  it('renders a long session title as one text node, truncated at the tail by CSS', async () => {
    const longTitle = '调查异常 AN-027 的全部追溯材料并完成质量审阅与证据整理 AN-027'
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [{ ...session('long', '/workspace'), title: longTitle }],
          workspaces: [workspace('/workspace', '主工作区')],
          labels: new Map(),
          currentId: 'long',
          runtimePlatform: 'win32',
          sessionPending: false,
          newDisabled: false,
        },
        actions: {
          openSession: vi.fn(),
          sessionAction: vi.fn(),
          newSession: vi.fn(),
          addWorkspace: vi.fn(),
          openSettings: vi.fn(),
        },
      },
    })
    const button = document.querySelector<HTMLButtonElement>('[data-session="long"]')
    expect(button?.getAttribute('title')).toBe(longTitle)
    const title = button?.querySelector('.session-title')
    expect(title?.textContent).toBe(longTitle)
    // 尾部省略交给行级 text-overflow；不再拆「前段 + 末 10 字」两段。
    expect(title?.querySelector('.navigation-label, .navigation-label-start')).toBeNull()
  })
})
