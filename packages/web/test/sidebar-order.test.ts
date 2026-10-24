/** @vitest-environment happy-dom */

import type { WorkspaceEntry } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SECTION_ORDER,
  orderSections,
  orderWorkspaces,
  sidebarOrder,
  workspaceKey,
} from '../src/sidebar-order.js'

const SECTION_KEY = 'agnes.sidebar.section-order.v1'
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
  it('starts from the default order and allows nothing else', () => {
    expect(orderSections(['pinned', 'chats', 'workspaces'])).toEqual([...DEFAULT_SECTION_ORDER])
    expect(orderSections(['workspaces', 'pinned'])).toEqual(['pinned', 'workspaces'])
  })

  it('cleans unknown values and duplicates found in storage', async () => {
    localStorage.setItem(SECTION_KEY, JSON.stringify(['chats', 'nope', 'chats', 'workspaces']))
    vi.resetModules()
    const reloaded = await import('../src/sidebar-order.js')
    expect(reloaded.orderSections(['pinned', 'chats', 'workspaces'])).toEqual([
      'chats',
      'workspaces',
      'pinned',
    ])
  })

  it('moves a section before or after its target and keeps hidden sections in place', () => {
    sidebarOrder.moveSection('pinned', 'chats', 'after')
    expect(orderSections(['pinned', 'chats', 'workspaces'])).toEqual(['chats', 'pinned', 'workspaces'])
    // An empty section is not rendered, but the saved order still holds it.
    expect(orderSections(['pinned', 'workspaces'])).toEqual(['pinned', 'workspaces'])
    sidebarOrder.moveSection('pinned', 'workspaces', 'after')
    expect(orderSections(['pinned', 'workspaces'])).toEqual(['workspaces', 'pinned'])
    expect(orderSections(['pinned', 'chats', 'workspaces'])).toEqual(['chats', 'workspaces', 'pinned'])
  })

  it('ignores a move against itself or a missing target', () => {
    sidebarOrder.moveSection('pinned', 'pinned', 'after')
    sidebarOrder.moveSection('chats', 'workspaces', 'before')
    expect(orderSections(['pinned', 'chats', 'workspaces'])).toEqual(['pinned', 'chats', 'workspaces'])
  })

  it('keeps working in memory when storage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    sidebarOrder.moveSection('pinned', 'workspaces', 'after')
    expect(orderSections(['pinned', 'chats', 'workspaces'])).toEqual(['chats', 'workspaces', 'pinned'])
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
  it('forgets both orders and removes the stored keys', () => {
    sidebarOrder.moveSection('pinned', 'workspaces', 'after')
    sidebarOrder.moveWorkspace(['/alpha', '/gamma'], '/gamma', '/alpha', 'before')
    sidebarOrder.reset()
    expect(orderSections(['pinned', 'chats', 'workspaces'])).toEqual([...DEFAULT_SECTION_ORDER])
    expect(sidebarOrder.getSnapshot().workspaces).toEqual([])
    expect(localStorage.getItem(SECTION_KEY)).toBeNull()
    expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull()
  })
})
