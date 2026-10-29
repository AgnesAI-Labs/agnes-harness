/** @vitest-environment happy-dom */

import type { WorkspaceEntry } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { orderWorkspaces, SIDEBAR_SECTION_ORDER, sidebarOrder, workspaceKey } from '../src/sidebar-order.js'

const WORKSPACE_KEY = 'agnes.sidebar.workspace-order.v1'

const workspace = (path: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({
  path,
  name: path.split('/').at(-1) ?? path,
  lastUsedAt: null,
  sessionCount: 0,
  available: true,
  ...extra,
})

afterEach(() => {
  sidebarOrder.reset()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('section order', () => {
  it('is fixed: 置顶 → 项目 → 临时会话, and the store offers no way to move a section', () => {
    expect(SIDEBAR_SECTION_ORDER).toEqual(['pinned', 'workspaces', 'chats'])
    expect(Object.keys(sidebarOrder).filter((key) => /section/i.test(key))).toEqual([])
  })
})

describe('workspace order', () => {
  const alpha = workspace('/alpha')
  const beta = workspace('/beta', { workspaceId: 'beta-id' })
  const gamma = workspace('/gamma')
  const chats = workspace('/chats', { kind: 'chats' })

  it('defaults to the order the daemon returned', () => {
    expect(orderWorkspaces([alpha, beta, gamma]).map((entry) => entry.path)).toEqual([
      '/alpha',
      '/beta',
      '/gamma',
    ])
  })

  it('keys by workspace id first, then by path', () => {
    expect(workspaceKey(beta)).toBe('beta-id')
    expect(workspaceKey(alpha)).toBe('/alpha')
  })

  it('moves a project and keeps the chats workspace out of the saved order', () => {
    sidebarOrder.moveWorkspace(['/alpha', 'beta-id', '/gamma'], 'beta-id', '/alpha', 'before')
    expect(sidebarOrder.getSnapshot().workspaces).toEqual(['beta-id', '/alpha', '/gamma'])
    expect(orderWorkspaces([alpha, beta, gamma]).map((entry) => entry.path)).toEqual([
      '/beta',
      '/alpha',
      '/gamma',
    ])
    // The managed chats workspace always renders in its own section, after the projects.
    expect(orderWorkspaces([alpha, beta, gamma, chats]).map((entry) => entry.path)).toEqual([
      '/beta',
      '/alpha',
      '/gamma',
      '/chats',
    ])
    expect(sidebarOrder.getSnapshot().workspaces).not.toContain('/chats')
  })

  it('ignores removed projects and appends new ones at the end', () => {
    sidebarOrder.moveWorkspace(['/alpha', 'beta-id'], 'beta-id', '/alpha', 'before')
    // /alpha is removed; the saved key stays in storage but no longer renders.
    expect(orderWorkspaces([beta, gamma])).toEqual([beta, gamma])
    expect(sidebarOrder.getSnapshot().workspaces).toEqual(['beta-id', '/alpha'])
    // A new project joins after the saved ones, in daemon order.
    expect(orderWorkspaces([alpha, beta, gamma]).map((entry) => entry.path)).toEqual([
      '/beta',
      '/alpha',
      '/gamma',
    ])
  })

  it('cleans duplicate keys found in storage', async () => {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(['beta-id', 'beta-id', '/gamma']))
    vi.resetModules()
    const reloaded = await import('../src/sidebar-order.js')
    expect(reloaded.sidebarOrder.getSnapshot().workspaces).toEqual(['beta-id', '/gamma'])
  })

  it('keeps working in memory when storage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    sidebarOrder.moveWorkspace(['/alpha', '/gamma'], '/gamma', '/alpha', 'before')
    expect(orderWorkspaces([alpha, gamma]).map((entry) => entry.path)).toEqual(['/gamma', '/alpha'])
  })
})

describe('reset', () => {
  it('forgets the project order and removes the stored key', () => {
    sidebarOrder.moveWorkspace(['/alpha', '/gamma'], '/gamma', '/alpha', 'before')
    sidebarOrder.reset()
    expect(sidebarOrder.getSnapshot().workspaces).toEqual([])
    expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull()
  })
})
