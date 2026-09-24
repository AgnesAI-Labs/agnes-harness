/** @vitest-environment happy-dom */

import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetCollapsedGroups } from '../src/navigation.js'
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
    // 折叠记录是模块级状态，不清会在用例之间串。
    resetCollapsedGroups()
  })

  it('renders the component-owned navigation, workspace groups, menus, and actions', async () => {
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
    expect(sidebar?.querySelector('.workspace-name')?.textContent).toBe('主工作区')
    const sessionButton = sidebar?.querySelector<HTMLButtonElement>('[data-session="one"]')
    expect(sessionButton?.getAttribute('aria-current')).toBe('page')
    sessionButton?.click()
    expect(openSession).toHaveBeenCalledWith('one')

    sidebar?.querySelector<HTMLButtonElement>('.workspace-heading')?.click()
    expect((sidebar?.querySelector('.workspace-sessions') as HTMLElement | null)?.hidden).toBe(true)
    sidebar?.querySelector<HTMLButtonElement>('.session-menu-trigger')?.click()
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click()
    expect(sessionAction).toHaveBeenCalledWith('rename', 'one', '会话 one', expect.any(HTMLElement))
    sidebar?.querySelector<HTMLButtonElement>('#new')?.click()
    sidebar?.querySelector<HTMLButtonElement>('#workspace-add')?.click()
    sidebar?.querySelector<HTMLButtonElement>('#settings')?.click()
    expect(newSession).toHaveBeenCalledOnce()
    expect(addWorkspace).toHaveBeenCalledOnce()
    expect(openSettings).toHaveBeenCalledOnce()
  })

  // 回归：导航区每次状态更新都用 replaceChildren 整体重建，折叠态必须活过重建。
  // 旧实现把折叠态只写在 DOM 上，重建后一律回到展开，在活跃会话下观感是「点了没反应」。
  it('keeps a collapsed workspace group across a rebuild', async () => {
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
    const heading = () => sidebar?.querySelector<HTMLButtonElement>('.workspace-heading')
    const children = () => sidebar?.querySelector('.workspace-sessions') as HTMLElement | null

    heading()?.click()
    expect(children()?.hidden).toBe(true)
    expect(heading()?.getAttribute('aria-expanded')).toBe('false')

    // 数据真的变了（新会话入列）⇒ 导航区必然重建，折叠态必须活下来。
    runtime.sidebar?.update({
      ...state,
      sessions: [session('one', '/workspace'), session('two', '/workspace')],
    })

    expect(children()?.hidden).toBe(true)
    expect(heading()?.getAttribute('aria-expanded')).toBe('false')

    // 收起状态不得变成「点不开」：再点一次应当恢复展开。
    heading()?.click()
    expect(children()?.hidden).toBe(false)
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

    // 数据变化时必须重建，否则界面会停在旧数据上。
    runtime.sidebar?.update(sidebarState([session('one', '/workspace'), session('two', '/workspace')]))
    expect(sidebar?.querySelector('.workspace-sessions')).not.toBe(before)
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
