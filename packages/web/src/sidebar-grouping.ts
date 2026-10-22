/**
 * How the sidebar arranges its sessions: one group per workspace, or one flat list. The heading,
 * the view menu and the list all read this one store, so they cannot disagree.
 */
export type SidebarGrouping = 'workspace' | 'list'

const KEY = 'agnes.sidebar.grouping.v1'

function read(): SidebarGrouping {
  try {
    return localStorage.getItem(KEY) === 'list' ? 'list' : 'workspace'
  } catch {
    // Private windows and disabled storage fall back to the default instead of failing.
    return 'workspace'
  }
}

let grouping: SidebarGrouping = read()
const listeners = new Set<() => void>()

function publish(next: SidebarGrouping): void {
  grouping = next
  for (const listener of listeners) listener()
}

export const sidebarGrouping = {
  getSnapshot: (): SidebarGrouping => grouping,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  setGrouping(next: SidebarGrouping): void {
    if (next === grouping) return
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* the in-memory choice keeps working */
    }
    publish(next)
  },
  /** Test cleanup: back to the default and forget the stored choice. */
  reset(): void {
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* nothing stored to remove */
    }
    publish('workspace')
  },
}
