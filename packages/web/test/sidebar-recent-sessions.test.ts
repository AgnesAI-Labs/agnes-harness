/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import type { SidebarGroupState } from '@agnes/web-units'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
import {
  RECENT_SESSIONS,
  renderSessionNavigation,
  resetCollapsedGroups,
  resetExpandedGroups,
  shownSessions,
} from '../src/navigation.js'
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
  document.body.replaceChildren()
})

describe('recent sessions per workspace', () => {
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
      delete group.error
      group.loading = true
      flushSync(draw)
      expect(more.disabled).toBe(true)
      expect(nav.querySelector('.workspace-sessions')?.getAttribute('aria-busy')).toBe('true')
      expect(nav.querySelector('[role="status"]')).toBeNull()
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
      const heading = nav.querySelector<HTMLButtonElement>('.workspace-heading')
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
