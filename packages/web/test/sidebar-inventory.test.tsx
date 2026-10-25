/** @vitest-environment happy-dom */

import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import { mountRegion } from '@agnes/web-ui'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionNavigation } from '../src/navigation.js'
import { bindNavigationHistory } from '../src/navigation-history.js'
import { SessionListLabel, SessionListTools } from '../src/regions/session-tools.js'
import { sessionInventory } from '../src/session-inventory.js'
import { resetCollapsedGroups, resetExpandedGroups } from '../src/sidebar-collapse.js'
import { sidebarGrouping } from '../src/sidebar-grouping.js'
import { groupInventoryRows, sortSessionsByActivity } from '../src/sidebar-groups.js'
import { orderSections, sidebarOrder } from '../src/sidebar-order.js'
import { zhT } from './helpers/locale.js'

type Row = PageSessionMeta['items'][number]

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  sessionInventory.reset()
  sidebarGrouping.reset()
  resetCollapsedGroups()
  resetExpandedGroups()
  sidebarOrder.reset()
  vi.restoreAllMocks()
})

function mount(element: ReactElement): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  cleanups.push(mountRegion(host, element))
  return host
}

const row = (id: string, overrides: Partial<Row> = {}): Row =>
  ({
    sessionId: id,
    title: `会话 ${id}`,
    cwd: '/workspace',
    archived: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastSeq: 1,
    generation: 1,
    preset: 'code',
    ...overrides,
  }) as Row

const workspace = (path: string, name: string): WorkspaceEntry => ({
  path,
  name,
  lastUsedAt: null,
  sessionCount: 1,
  available: true,
})

function options(
  sessions: readonly Row[],
  workspaces: readonly WorkspaceEntry[],
  extra: Record<string, unknown> = {},
) {
  return {
    sessions: [...sessions],
    workspaces,
    labels: new Map<string, string>(),
    disabled: false,
    newDisabled: false,
    newSession: vi.fn(),
    open: vi.fn(),
    ...extra,
  }
}

function bind(items: readonly Row[]) {
  const list = vi.fn(async () => ({ items: [...items] }))
  const restore = vi.fn().mockResolvedValue(undefined)
  const changed = vi.fn().mockResolvedValue(undefined)
  sessionInventory.bind({ list, restore, changed, error: vi.fn() })
  return { list, restore, changed }
}

/** React tracks the DOM value, so write it through the native setter before announcing the change. */
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const labelled = (host: HTMLElement, name: string): HTMLButtonElement => {
  const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent === name)
  if (!button) throw new Error(`no button named ${name}`)
  return button
}

describe('sidebar heading', () => {
  it('keeps 工作区 and leaves only search and the view menu in the heading', () => {
    const host = mount(
      <div className="sidebar-section-heading">
        <p className="section-label">
          <SessionListLabel t={zhT} />
        </p>
        <SessionListTools t={zhT} />
      </div>,
    )
    expect(host.querySelector('.section-label')?.textContent).toBe('工作区')
    const controls = [...host.querySelectorAll('button')].map((button) => button.id)
    expect(controls).toEqual(['session-search', 'session-view'])
    // 归档没有单独的快捷按钮：筛选只从视图菜单进入。
    expect(host.querySelector('#session-archive')).toBeNull()
  })

  it('offers two groups of choices and marks the current ones', async () => {
    const host = mount(<SessionListTools t={zhT} />)
    host.querySelector<HTMLButtonElement>('#session-view')?.click()
    const items = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      if (!found.length) throw new Error('the view menu has not opened yet')
      return found
    })
    expect([...document.querySelectorAll('.agh-menu-group-label')].map((node) => node.textContent)).toEqual([
      '分组方式',
      '筛选会话',
      '顺序',
    ])
    expect(items.map((item) => item.textContent)).toEqual([
      '按工作区',
      '单列表',
      '隐藏已归档',
      '全部对话（显示已归档）',
      '仅显示已归档',
      '重置顺序',
    ])
    expect(items[0]?.getAttribute('data-checked')).toBe('true')
    expect(items[0]?.getAttribute('aria-label')).toBe('按工作区, 已选中')
    expect(items[2]?.getAttribute('data-checked')).toBe('true')
    expect(items[1]?.getAttribute('data-checked')).toBeNull()

    items[1]?.click()
    await vi.waitFor(() => expect(sidebarGrouping.getSnapshot()).toBe('list'))
    await vi.waitFor(() =>
      expect(host.querySelector('#session-view')?.getAttribute('aria-expanded')).toBe('false'),
    )
  })

  it('resets the saved section and project orders from the view menu', async () => {
    sidebarOrder.moveSection('pinned', 'workspaces', 'after')
    sidebarOrder.moveWorkspace(['/alpha', '/beta'], '/beta', '/alpha', 'before')
    const host = mount(<SessionListTools t={zhT} />)
    host.querySelector<HTMLButtonElement>('#session-view')?.click()
    const reset = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid="session-view-order-reset"]')
      if (!found) throw new Error('the order reset item has not rendered yet')
      return found
    })
    reset.click()
    expect(orderSections(['pinned', 'chats', 'workspaces'])).toEqual(['pinned', 'chats', 'workspaces'])
    expect(sidebarOrder.getSnapshot().workspaces).toEqual([])
    expect(localStorage.getItem('agnes.sidebar.section-order.v1')).toBeNull()
    expect(localStorage.getItem('agnes.sidebar.workspace-order.v1')).toBeNull()
  })

  it('enters and leaves the archived filter from the menu', async () => {
    const host = mount(<SessionListTools t={zhT} />)
    const choose = async (testId: string) => {
      host.querySelector<HTMLButtonElement>('#session-view')?.click()
      const item = await vi.waitFor(() => {
        const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
        if (!found) throw new Error('the view menu has not opened yet')
        return found
      })
      item.click()
      await vi.waitFor(() =>
        expect(host.querySelector('#session-view')?.getAttribute('aria-expanded')).toBe('false'),
      )
    }
    await choose('session-view-filter-archived')
    await vi.waitFor(() => expect(sessionInventory.getSnapshot().mode).toBe('archived'))
    await choose('session-view-filter-active')
    await vi.waitFor(() => expect(sessionInventory.getSnapshot().mode).toBe('active'))
  })

  it('changes the heading to 会话 for the single list', () => {
    sidebarGrouping.setGrouping('list')
    const host = mount(<SessionListLabel t={zhT} />)
    expect(host.textContent).toBe('会话')
  })

  it('disables the two views an older host cannot serve and says why', async () => {
    // A host port must hand back a stable snapshot and a stable subscribe, or React re-renders forever.
    const snapshot = { filter: 'unarchived' as const, rows: [], status: 'idle' as const, restoring: [] }
    const unsubscribe = () => undefined
    const legacy = {
      getSnapshot: () => snapshot,
      subscribe: () => unsubscribe,
      show: vi.fn(),
      reload: async () => undefined,
      restore: async () => undefined,
    }
    const unbind = bindNavigationHistory(legacy)
    cleanups.push(unbind)
    const host = mount(<SessionListTools t={zhT} />)
    host.querySelector<HTMLButtonElement>('#session-view')?.click()
    const items = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      if (!found.length) throw new Error('the view menu has not opened yet')
      return found
    })
    // 「单列表」 needs `setMode`; 「仅显示已归档」 still works through the two-state `show`.
    expect(items[1]?.getAttribute('aria-disabled')).toBe('true')
    expect(items[3]?.getAttribute('aria-disabled')).toBe('true')
    expect(items[4]?.getAttribute('aria-disabled')).not.toBe('true')
    items[4]?.click()
    expect(legacy.show).toHaveBeenCalledWith('archived')
  })
})

describe('session navigation', () => {
  it('keeps the paged projection for the default view and reads nothing extra', async () => {
    const { list } = bind([row('one')])
    const host = mount(
      <SessionNavigation options={options([row('one')], [workspace('/workspace', '主工作区')])} t={zhT} />,
    )
    expect(host.querySelector('.workspace-group')).not.toBeNull()
    expect(host.querySelector('[data-session="one"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="session-inventory"]')).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('flattens the list, drops the group headings and reads the whole list once', async () => {
    sidebarGrouping.setGrouping('list')
    const { list } = bind([row('one'), row('two')])
    const host = mount(
      <SessionNavigation options={options([row('one')], [workspace('/workspace', '主工作区')])} t={zhT} />,
    )
    await vi.waitFor(() => expect(host.querySelector('[data-session="two"]')).not.toBeNull())
    expect(host.querySelector('[data-testid="session-inventory"]')).not.toBeNull()
    expect(host.querySelector('.workspace-group')).toBeNull()
    expect(host.querySelector('.session-workspace-label')?.textContent).toBe('主工作区')
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('keeps the activity order inside a project in the full-list view', async () => {
    sessionInventory.setMode('all')
    // Created later but last active earlier: creation order and activity order disagree.
    bind([
      row('created-later', {
        cwd: '/workspace',
        createdAt: '2026-10-05T00:00:00.000Z',
        lastMessageAt: '2026-10-01T00:00:00.000Z',
      }),
      row('active-later', {
        cwd: '/workspace',
        createdAt: '2026-10-01T00:00:00.000Z',
        lastMessageAt: '2026-10-09T00:00:00.000Z',
      }),
    ])
    const host = mount(
      <SessionNavigation options={options([], [workspace('/workspace', '主工作区')])} t={zhT} />,
    )
    await vi.waitFor(() => expect(host.querySelector('[data-session="active-later"]')).not.toBeNull())
    expect(
      [...host.querySelectorAll<HTMLElement>('.workspace-group [data-session]')].map(
        (node) => node.dataset.session,
      ),
    ).toEqual(['active-later', 'created-later'])
  })

  it('renders pinned and chats as peer sections inside the workspace list', async () => {
    const chats: WorkspaceEntry = { ...workspace('/chats', 'chats'), kind: 'chats' }
    sessionInventory.setMode('all')
    bind([
      row('pinned', { cwd: '/workspace', pinnedAt: '2026-10-02T00:00:00.000Z' }),
      row('chat', { cwd: '/chats' }),
      row('one', { cwd: '/workspace' }),
    ])
    const input = options([], [workspace('/workspace', '主工作区'), chats])
    const leading = mount(<SessionNavigation leading options={input} t={zhT} />)
    const main = mount(<SessionNavigation options={input} t={zhT} />)
    await vi.waitFor(() => expect(main.querySelector('[data-session="chat"]')).not.toBeNull())
    // 分组视图的前置槽位不再渲染第二份列表。
    expect(leading.innerHTML).toBe('')
    expect(main.querySelector('[data-testid="session-inventory"]')).not.toBeNull()
    const sections = [...main.querySelectorAll<HTMLElement>('.sidebar-section')]
    expect(sections.map((section) => section.dataset.section)).toEqual(['pinned', 'chats', 'workspaces'])
    expect(
      [...main.querySelectorAll('.sidebar-section > .workspace-heading-row .workspace-name')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['置顶', '临时会话', '工作区'])
    expect(
      [...main.querySelectorAll('.workspace-group .workspace-name')].map((node) => node.textContent),
    ).toEqual(['主工作区'])
    // 每个会话只出现一次，置顶与临时会话没有混进工作区分区。
    const projects = main.querySelector('[data-section="workspaces"]') as HTMLElement
    expect(projects.querySelector('[data-session="pinned"]')).toBeNull()
    expect(projects.querySelector('[data-session="chat"]')).toBeNull()
    expect(projects.querySelector('[data-session="one"]')).not.toBeNull()
  })

  it('keeps pinned and chats rows above the flat list in single-list mode', async () => {
    sidebarGrouping.setGrouping('list')
    const chats: WorkspaceEntry = { ...workspace('/chats', 'chats'), kind: 'chats' }
    bind([
      row('pinned', { cwd: '/workspace', pinnedAt: '2026-10-02T00:00:00.000Z' }),
      row('chat', { cwd: '/chats' }),
      row('one', { cwd: '/workspace' }),
    ])
    const input = options([], [workspace('/workspace', '主工作区'), chats])
    const leading = mount(<SessionNavigation leading options={input} t={zhT} />)
    const main = mount(<SessionNavigation options={input} t={zhT} />)
    await vi.waitFor(() => expect(leading.querySelector('[data-session="chat"]')).not.toBeNull())
    const ids = (host: HTMLElement) =>
      [...host.querySelectorAll<HTMLElement>('[data-session]')].map((node) => node.dataset.session)
    expect(ids(leading)).toEqual(['pinned', 'chat'])
    expect(ids(main)).toEqual(['one'])
    expect(main.querySelector('[data-testid="session-inventory"]')).not.toBeNull()
  })

  it('marks the managed chats workspace as its own group kind', () => {
    const groups = groupInventoryRows(
      [row('chat', { cwd: '/chats' })],
      [{ ...workspace('/chats', 'chats'), kind: 'chats' }, workspace('/workspace', '主工作区')],
    )
    expect(groups.map((group) => group.kind)).toEqual(['chats'])
  })

  it('marks archived rows in 全部对话 but still opens and restores them', async () => {
    const open = vi.fn()
    const { restore } = bind([row('one'), row('old', { archived: true })])
    sessionInventory.setMode('all')
    const host = mount(
      <SessionNavigation options={options([], [workspace('/workspace', '主工作区')], { open })} t={zhT} />,
    )
    const archived = await vi.waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-session="old"]')
      if (!found) throw new Error('the archived row has not rendered yet')
      return found
    })
    expect(archived.closest('.session-row')?.getAttribute('data-archived')).toBe('true')
    // 归档行仍可打开：置灰只表达状态，不拦截操作。
    archived.click()
    expect(open).toHaveBeenCalledWith('old')
    host.querySelector<HTMLButtonElement>('[data-testid="archived-restore"]')?.click()
    await vi.waitFor(() => expect(restore).toHaveBeenCalledWith('old'))
  })

  it('shows only archived rows, skips empty workspaces and offers its own search', async () => {
    bind([row('old', { archived: true, cwd: '/a' }), row('one', { cwd: '/b' })])
    sessionInventory.setMode('archived')
    const host = mount(
      <SessionNavigation options={options([], [workspace('/a', '一'), workspace('/b', '二')])} t={zhT} />,
    )
    await vi.waitFor(() => expect(host.querySelector('[data-session="old"]')).not.toBeNull())
    expect(host.querySelectorAll('.workspace-group')).toHaveLength(1)
    expect(host.querySelector('[data-session="one"]')).toBeNull()
    expect(host.querySelector('[data-testid="archived-search"]')).not.toBeNull()
    expect(sessionInventory.getSnapshot().rows.map((item) => item.sessionId)).toEqual(['old'])
  })

  it('sends an empty archived filter back to the sessions with one click', async () => {
    bind([row('one')])
    sessionInventory.setMode('archived')
    const host = mount(
      <SessionNavigation options={options([], [workspace('/workspace', '主工作区')])} t={zhT} />,
    )
    await vi.waitFor(() => expect(host.querySelector('.agh-empty-state')).not.toBeNull())
    expect(host.querySelector('.agh-empty-state')?.textContent).toContain('暂无已归档会话。')
    labelled(host, '查看其他会话').click()
    await vi.waitFor(() => expect(sessionInventory.getSnapshot().mode).toBe('active'))
  })

  it('filters the archived view by title and workspace and keeps the switch out of the result', async () => {
    bind([
      row('alpha', { archived: true, title: '季度复盘' }),
      row('beta', { archived: true, title: '预算' }),
    ])
    sessionInventory.setMode('archived')
    const host = mount(
      <SessionNavigation options={options([], [workspace('/workspace', '主工作区')])} t={zhT} />,
    )
    await vi.waitFor(() => expect(host.querySelector('[data-session="beta"]')).not.toBeNull())
    const search = host.querySelector<HTMLInputElement>('[data-testid="archived-search"]')
    if (!search) throw new Error('the archived search did not render')
    type(search, '季度')
    await vi.waitFor(() => expect(host.querySelector('[data-session="beta"]')).toBeNull())
    expect(host.querySelector('[data-session="alpha"]')).not.toBeNull()

    type(search, '不存在')
    await vi.waitFor(() =>
      expect(host.querySelector('.agh-empty-state')?.textContent).toContain('没有匹配的已归档会话。'),
    )
    // 搜索无匹配时不提供「查看其他会话」：搜索框才是退路。
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).not.toContain(
      '查看其他会话',
    )
  })

  it('remembers the grouping and the filter across a remount', async () => {
    bind([row('old', { archived: true })])
    sidebarGrouping.setGrouping('list')
    sessionInventory.setMode('archived')
    const first = mount(
      <SessionNavigation options={options([], [workspace('/workspace', '主工作区')])} t={zhT} />,
    )
    await vi.waitFor(() => expect(first.querySelector('[data-session="old"]')).not.toBeNull())
    const second = mount(
      <SessionNavigation options={options([], [workspace('/workspace', '主工作区')])} t={zhT} />,
    )
    expect(second.querySelector('.workspace-group')).toBeNull()
    expect(sessionInventory.getSnapshot().mode).toBe('archived')
    expect(sidebarGrouping.getSnapshot()).toBe('list')
  })
})

describe('full-list ordering', () => {
  it('sorts by last message, falls back to creation time and keeps unreadable rows in order', () => {
    const rows = [
      row('none'),
      row('created-later', { createdAt: '2026-10-02T00:00:00.000Z' }),
      row('messaged', { lastMessageAt: '2026-10-03T00:00:00.000Z' }),
    ]
    expect(sortSessionsByActivity(rows).map((entry) => entry.sessionId)).toEqual([
      'messaged',
      'created-later',
      'none',
    ])
  })

  it('puts pinned sessions first, then workspaces in sidebar order, then unregistered folders', () => {
    const rows = [
      { ...row('unbound'), cwd: undefined } as unknown as Row,
      row('in-b', { cwd: '/b' }),
      row('pinned', { cwd: '/b', pinnedAt: '2026-10-03T00:00:00.000Z' }),
      row('in-empty-a', { cwd: '/a' }),
    ]
    const groups = groupInventoryRows(rows, [
      workspace('/a', '一'),
      workspace('/b', '二'),
      workspace('/c', '三'),
    ])
    expect(groups.map((group) => group.id)).toEqual(['pinned', '/a', '/b', ''])
    expect(groups[0]?.rows.map((entry) => entry.sessionId)).toEqual(['pinned'])
    expect(groups[1]?.rows.map((entry) => entry.sessionId)).toEqual(['in-empty-a'])
    expect(groups[2]?.rows.map((entry) => entry.sessionId)).toEqual(['in-b'])
    expect(groups[3]?.rows.map((entry) => entry.sessionId)).toEqual(['unbound'])
  })

  it('never pins an archived row', () => {
    const groups = groupInventoryRows(
      [row('old', { archived: true, pinnedAt: '2026-10-03T00:00:00.000Z' })],
      [workspace('/workspace', '主工作区')],
    )
    expect(groups.map((group) => group.kind)).toEqual(['workspace'])
  })
})
