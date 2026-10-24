/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import type { PageSessionMeta, SessionGroupsResult, WorkspaceEntry } from '@agnes/protocol'
import { mountRegion, renderRegion } from '@agnes/web-ui'
import type { SidebarGroupState } from '@agnes/web-units'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
import {
  RECENT_SESSIONS,
  renderSessionNavigation,
  resetCollapsedGroups,
  resetExpandedGroups,
  SessionNavigation,
  shownSessions,
} from '../src/navigation.js'
import { sidebarOrder } from '../src/sidebar-order.js'
import { createSidebarPagination } from '../src/sidebar-pagination.js'
import { zhT } from './helpers/locale.js'

const WORKSPACE = '/work/WorkLLM'
const session = (index: number): PageSessionMeta['items'][number] =>
  ({
    sessionId: `s${index}`,
    title: `会话 ${index}`,
    cwd: WORKSPACE,
    archived: false,
    // s0 is the newest.
    createdAt: new Date(Date.UTC(2026, 9, 14, 12) - index * 60_000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 14, 12) - index * 60_000).toISOString(),
    lastSeq: 1,
    generation: 1,
    preset: 'code',
  }) as PageSessionMeta['items'][number]
const workspace: WorkspaceEntry = {
  path: WORKSPACE,
  name: 'WorkLLM',
  lastUsedAt: null,
  sessionCount: 8,
  available: true,
}

function render(currentId?: string, sessions = Array.from({ length: 8 }, (_, index) => session(index))) {
  const nav = document.createElement('nav')
  document.body.append(nav)
  const draw = () =>
    renderSessionNavigation(
      {
        nav,
        sessions,
        workspaces: [workspace],
        labels: new Map(),
        ...(currentId ? { currentId } : {}),
        newSession: vi.fn(),
        open: vi.fn(),
      },
      zhT,
    )
  flushSync(draw)
  return nav
}
const titles = (nav: Element) => [...nav.querySelectorAll('.session-title')].map((node) => node.textContent)

afterEach(() => {
  resetExpandedGroups()
  resetCollapsedGroups()
  sidebarOrder.reset()
  document.body.replaceChildren()
})

describe('recent sessions per workspace', () => {
  it.each(['success', 'summary failure', 'page failure'] as const)(
    'retains rows and the disabled pagination button throughout a message refresh: %s',
    async (outcome) => {
      const nav = document.createElement('nav')
      document.body.append(nav)
      const summary: SessionGroupsResult = {
        ready: true,
        items: [
          { groupId: 'a', workspaceId: 'a', total: 8, revision: 'v1', ready: true, lastMessageAt: null },
        ],
      }
      const page: PageSessionMeta = {
        items: Array.from({ length: 5 }, (_, i) => session(i)),
        total: 8,
        revision: 'v1',
        next: 'old-cursor',
      }
      let finishSummary!: (value: SessionGroupsResult) => void,
        failSummary!: (error: unknown) => void,
        finishPage!: (value: PageSessionMeta) => void,
        failPage!: (error: unknown) => void
      const pendingSummary = new Promise<SessionGroupsResult>((resolve, reject) => {
        finishSummary = resolve
        failSummary = reject
      })
      const pendingPage = new Promise<PageSessionMeta>((resolve, reject) => {
        finishPage = resolve
        failPage = reject
      })
      const groups = vi.fn(async () => summary)
      const list = vi.fn(async () => page)
      const frames: {
        button: Element | null
        disabled: boolean | undefined
        reload: boolean
        row: Element | null
      }[] = []
      const ui = createSidebarPagination(
        { groups, list },
        () => {
          flushSync(() =>
            renderSessionNavigation(
              {
                nav,
                sessions: ui.rows(),
                workspaces: [{ ...workspace, workspaceId: 'a' }],
                labels: new Map(),
                newSession: vi.fn(),
                open: vi.fn(),
                paging: ui.snapshot(),
                groupAction: (id, action) => {
                  void ui.action(id, action)
                },
              },
              zhT,
            ),
          )
          const button = nav.querySelector<HTMLButtonElement>('[data-testid="workspace-sessions-toggle"]')
          frames.push({
            button,
            disabled: button?.disabled,
            reload: nav.textContent?.includes(zhT('nav.updated')) ?? false,
            row: nav.querySelector('[data-session="s0"]'),
          })
        },
        () => 'Failed',
      )
      await ui.refresh()
      const button = nav.querySelector<HTMLButtonElement>('[data-testid="workspace-sessions-toggle"]')
      const firstRow = nav.querySelector<HTMLButtonElement>('[data-session="s0"]')
      firstRow?.focus()
      const scroller = nav.querySelector<HTMLElement>('.workspace-sessions')
      if (scroller) scroller.scrollTop = 42
      frames.length = 0
      groups.mockImplementationOnce(() => pendingSummary)
      list.mockImplementationOnce(() => pendingPage)
      ui.invalidateSession('s0', WORKSPACE, [{ path: WORKSPACE, workspaceId: 'a' }])
      const refresh = ui.refresh()
      expect(nav.querySelector('[data-testid="workspace-sessions-toggle"]')).toBe(button)
      expect(button?.disabled).toBe(true)
      button?.click()
      await Promise.resolve()
      expect(list).toHaveBeenCalledTimes(1)
      if (outcome === 'summary failure') failSummary(new Error('offline'))
      else {
        finishSummary({ ...summary, items: summary.items.map((item) => ({ ...item, revision: 'v2' })) })
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
        expect(button?.disabled).toBe(true)
        button?.click()
        if (outcome === 'page failure') failPage(new Error('offline'))
        else finishPage({ ...page, revision: 'v2', next: 'fresh-cursor' })
      }
      await refresh
      const during = frames.slice(0, -1)
      expect(during.length).toBeGreaterThan(0)
      expect(
        during.every(
          (frame) => frame.button === button && frame.disabled && !frame.reload && frame.row === firstRow,
        ),
      ).toBe(true)
      expect(nav.querySelector('[data-session="s0"]')).toBe(firstRow)
      expect(document.activeElement).toBe(firstRow)
      expect(scroller?.scrollTop).toBe(42)
      if (outcome === 'success') {
        expect(frames.every((frame) => frame.button === button && !frame.reload)).toBe(true)
        expect(button?.disabled).toBe(false)
        expect(ui.snapshot().groups[0]?.next).toBe('fresh-cursor')
      } else {
        expect(nav.textContent).toContain('Failed')
        expect(nav.textContent).toContain(zhT('nav.reload'))
        expect(nav.querySelector('[data-testid="workspace-sessions-toggle"]')).toBeNull()
      }
    },
  )
  it.each(['win32', 'darwin'] as const)(
    'renders quiet server pages on %s and unmounts a closed group',
    (runtimePlatform) => {
      const nav = document.createElement('nav')
      document.body.append(nav)
      const action = vi.fn()
      const group: SidebarGroupState = {
        groupId: 'a',
        workspaceId: 'a',
        total: 17,
        revision: 'v1',
        lastMessageAt: null,
        ready: true,
        opened: true,
        loaded: true,
        loading: false,
        next: '5',
        items: [session(4), session(3), session(2), session(1), session(0)],
      }
      const draw = () =>
        renderSessionNavigation(
          {
            nav,
            sessions: [session(7)],
            workspaces: [{ ...workspace, workspaceId: 'a' }],
            labels: new Map(),
            currentId: 's7',
            runtimePlatform,
            newSession: vi.fn(),
            open: vi.fn(),
            groupAction: action,
            paging: { groups: [group], ready: true, loading: false },
          },
          zhT,
        )
      flushSync(draw)
      expect(titles(nav)).toEqual(['会话 4', '会话 3', '会话 2', '会话 1', '会话 0'])
      expect(nav.querySelector('[data-session="s7"]')).toBeNull()
      const more = nav.querySelector<HTMLButtonElement>('[data-testid="workspace-sessions-toggle"]')
      if (!more) throw new Error('missing pagination button')
      expect(more.textContent).toBe('展开显示（还有 12 条）')
      flushSync(() => more.click())
      expect(action).toHaveBeenLastCalledWith('a', 'more')
      group.error = 'Failed'
      flushSync(draw)
      flushSync(() =>
        [...nav.querySelectorAll('button')].find((button) => button.textContent === '重试')?.click(),
      )
      expect(action).toHaveBeenLastCalledWith('a', 'retry')
      group.loading = true
      flushSync(draw)
      expect(more.disabled).toBe(true)
      expect(nav.querySelector('.workspace-sessions')?.getAttribute('aria-busy')).toBe('true')
      expect(nav.querySelector('[role="status"]')).toBeNull()
      expect(nav.querySelector('[role="alert"]')).toBeNull()
      delete group.error
      group.stale = true
      flushSync(draw)
      expect(nav.querySelector('[role="status"]')).toBeNull()
      expect(nav.querySelector('[data-testid="workspace-sessions-toggle"]')).toBe(more)
      expect(more.disabled).toBe(true)
      expect(titles(nav)).toHaveLength(5)
      group.loading = false
      flushSync(draw)
      expect(nav.querySelector('[role="status"]')?.textContent).toContain(zhT('nav.updated'))
      group.stale = false
      group.loaded = false
      group.items = []
      group.loading = true
      flushSync(draw)
      expect(nav.querySelector('[role="status"]')?.textContent).toBe(zhT('nav.loading'))
      group.loading = false
      group.error = 'Failed'
      flushSync(draw)
      expect(nav.querySelector('[role="alert"]')?.textContent).toContain('Failed')
      delete group.error
      group.opened = false
      flushSync(draw)
      expect(titles(nav)).toEqual([])
      const heading = nav.querySelector<HTMLButtonElement>('.workspace-group.is-nested .workspace-heading')
      if (!heading) throw new Error('missing workspace heading')
      expect(heading.getAttribute('aria-expanded')).toBe('false')
      expect(document.getElementById(heading.getAttribute('aria-controls') ?? '')).not.toBeNull()
      flushSync(() => heading.click())
      expect(action).toHaveBeenLastCalledWith('a', 'toggle')
    },
  )
  it('shows the five most recent, then 「展开显示（还有 N 条）」, and all of them once expanded', async () => {
    expect(RECENT_SESSIONS).toBe(5)
    const nav = render()
    expect(titles(nav)).toEqual(['会话 0', '会话 1', '会话 2', '会话 3', '会话 4'])
    const toggle = nav.querySelector<HTMLButtonElement>('[data-testid="workspace-sessions-toggle"]')
    expect(toggle?.textContent).toBe('展开显示（还有 3 条）')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    flushSync(() => toggle?.click())
    await vi.waitFor(() => expect(titles(nav)).toHaveLength(8))
    expect(toggle?.textContent).toBe('收起')
    // Remembered on this computer, per workspace.
    expect(JSON.parse(localStorage.getItem('agnes.sidebar.expanded-workspaces.v1') ?? '[]')).toEqual([
      WORKSPACE,
    ])
    flushSync(() => toggle?.click())
    await vi.waitFor(() => expect(titles(nav)).toHaveLength(5))
  })

  it('keeps the open session in its place even when it is older than the five shown', () => {
    const nav = render('s7')
    expect(titles(nav)).toEqual(['会话 0', '会话 1', '会话 2', '会话 3', '会话 4', '会话 7'])
    expect(nav.querySelector('[data-testid="workspace-sessions-toggle"]')?.textContent).toBe(
      '展开显示（还有 2 条）',
    )
  })

  it('offers nothing to expand for five or fewer sessions', () => {
    const nav = render(
      undefined,
      Array.from({ length: 5 }, (_, index) => session(index)),
    )
    expect(titles(nav)).toHaveLength(5)
    expect(nav.querySelector('[data-testid="workspace-sessions-toggle"]')).toBeNull()
    expect(shownSessions([{ sessionId: 'a' }], false, undefined)).toEqual({
      shown: [{ sessionId: 'a' }],
      hidden: 0,
    })
  })

  it('renders the managed chats workspace as its own 「临时会话」 section inside the list', () => {
    const chats: WorkspaceEntry = { ...workspace, path: '/data/chats', name: 'chats', kind: 'chats' }
    const newSession = vi.fn()
    const options = {
      sessions: [session(0), { ...session(1), cwd: chats.path }],
      workspaces: [workspace, chats],
      labels: new Map<string, string>(),
      newSession,
      open: vi.fn(),
      action: vi.fn(),
      workspaceAction: vi.fn(),
    }
    const nav = document.createElement('nav')
    document.body.append(nav)
    const cleanup = mountRegion(nav, createElement(SessionNavigation, { options, t: zhT }))
    try {
      const chatsSection = nav.querySelector<HTMLElement>('[data-section="chats"]')
      if (!chatsSection) throw new Error('the chats section did not render')
      expect(chatsSection.querySelector('.workspace-name')?.textContent).toBe('临时会话')
      expect(chatsSection.querySelector('.workspace-heading')?.getAttribute('title')).toBe('临时会话')
      expect(chatsSection.querySelector('.icon-folder')).toBeNull()
      expect(chatsSection.querySelector('.workspace-menu-trigger')).toBeNull()
      expect(titles(chatsSection)).toEqual(['会话 1'])
      // 工作区分区不再包含临时会话，只剩普通工作区。
      const projects = nav.querySelector('[data-section="workspaces"]')
      expect(
        [...(projects?.querySelectorAll('.workspace-group .workspace-name') ?? [])].map(
          (node) => node.textContent,
        ),
      ).toEqual(['WorkLLM'])
      expect(titles(projects as HTMLElement)).toEqual(['会话 0'])
      chatsSection.querySelector<HTMLButtonElement>('.workspace-new-session')?.click()
      expect(newSession).toHaveBeenCalledWith(chats)
    } finally {
      cleanup()
    }
  })

  it('renders no pinned or chats section when nothing is pinned and there is no chats workspace', () => {
    const nav = document.createElement('nav')
    document.body.append(nav)
    const cleanup = mountRegion(
      nav,
      createElement(SessionNavigation, {
        options: {
          sessions: [session(0)],
          workspaces: [workspace],
          labels: new Map<string, string>(),
          newSession: vi.fn(),
          open: vi.fn(),
        },
        t: zhT,
      }),
    )
    try {
      expect(nav.querySelector('[data-section="pinned"]')).toBeNull()
      expect(nav.querySelector('[data-section="chats"]')).toBeNull()
      expect(
        [...nav.querySelectorAll<HTMLElement>('.sidebar-section')].map((node) => node.dataset.section),
      ).toEqual(['workspaces'])
    } finally {
      cleanup()
    }
  })

  it('renders a non-empty 「置顶」 section with a pin and no workspace actions, offering 「取消置顶」', async () => {
    const nav = document.createElement('nav')
    document.body.append(nav)
    const group = (groupId: string, items: PageSessionMeta['items']): SidebarGroupState => ({
      groupId,
      ...(groupId === 'a' ? { workspaceId: 'a' } : {}),
      total: items.length,
      revision: 'v1',
      lastMessageAt: null,
      ready: true,
      opened: true,
      loaded: true,
      loading: false,
      items,
    })
    const options = (pinned: PageSessionMeta['items']) => ({
      sessions: [],
      workspaces: [{ ...workspace, workspaceId: 'a' }],
      labels: new Map<string, string>(),
      newSession: vi.fn(),
      open: vi.fn(),
      action: vi.fn(),
      workspaceAction: vi.fn(),
      paging: {
        groups: [group('pinned', pinned), group('a', [session(0)])],
        ready: true,
        loading: false,
      },
    })
    const draw = (pinned: PageSessionMeta['items']) =>
      flushSync(() =>
        renderRegion(nav, createElement(SessionNavigation, { options: options(pinned), t: zhT })),
      )
    const cleanup = mountRegion(nav, createElement(SessionNavigation, { options: options([]), t: zhT }))
    try {
      draw([])
      expect(nav.querySelector('[data-section="pinned"]')).toBeNull()
      expect(
        [...nav.querySelectorAll('[data-section="workspaces"] .workspace-group .workspace-name')].map(
          (node) => node.textContent,
        ),
      ).toEqual(['WorkLLM'])
      const pinned = { ...session(3), pinnedAt: '2026-10-20T08:00:00.000Z' }
      draw([pinned])
      const pinnedSection = nav.querySelector<HTMLElement>('[data-section="pinned"]')
      if (!pinnedSection) throw new Error('the pinned section did not render')
      expect(pinnedSection.querySelector('.workspace-name')?.textContent).toBe('置顶')
      expect(pinnedSection.querySelector('.workspace-heading')?.getAttribute('title')).toBe('置顶')
      expect(pinnedSection.querySelector('.icon-pinned')).not.toBeNull()
      expect(pinnedSection.querySelector('.workspace-menu-trigger')).toBeNull()
      expect(titles(pinnedSection)).toEqual(['会话 3'])
      // 置顶已移出工作区分区。
      const projects = nav.querySelector('[data-section="workspaces"]') as HTMLElement
      expect(titles(projects)).toEqual(['会话 0'])
      flushSync(() => pinnedSection.querySelector<HTMLButtonElement>('.session-menu-trigger')?.click())
      await vi.waitFor(() =>
        expect(document.querySelector('[role="menuitem"]')?.textContent).toBe('取消置顶'),
      )
    } finally {
      cleanup()
    }
  })

  it('draws the heading tools small and quiet: 24px buttons, 14px icons, darker when pointed at', () => {
    const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
    expect(css).toMatch(
      /\.sidebar-section-heading \.agh-btn--icon \{[^}]*width: 1\.5rem;[^}]*height: 1\.5rem;/,
    )
    expect(css).toMatch(/\.sidebar-section-heading \.agh-btn--icon svg \{[^}]*width: 0\.875rem;/)
    expect(css).toMatch(
      /\.sidebar-section-heading \.agh-btn--icon \{[^}]*color: var\(--agnes-text-tertiary\);/,
    )
  })
})
