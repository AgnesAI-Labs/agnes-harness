import type { WorkspaceEntry } from '@agnes/protocol'

/**
 * The user's own order of the projects inside the 项目 section. It lives in local storage like the
 * grouping and collapse records, so it survives reloads but stays on this computer. Saved entries
 * that no longer exist are kept in storage but ignored when rendering; a move rewrites the
 * effective order. The three sections themselves have one fixed order and cannot be moved.
 */
export type SidebarSectionId = 'pinned' | 'chats' | 'workspaces'

export type DropPosition = 'before' | 'after'

/** 置顶 → 项目 → 临时会话, always. */
export const SIDEBAR_SECTION_ORDER: readonly SidebarSectionId[] = ['pinned', 'workspaces', 'chats']

const WORKSPACE_KEY = 'agnes.sidebar.workspace-order.v1'

export type SidebarOrderSnapshot = {
  workspaces: readonly string[]
}

function readStored(key: string): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function writeStored(key: string, values: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(values))
  } catch {
    /* the in-memory order keeps working */
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

let order: SidebarOrderSnapshot = { workspaces: unique(readStored(WORKSPACE_KEY)) }
const listeners = new Set<() => void>()

function publish(next: SidebarOrderSnapshot): void {
  order = next
  for (const listener of listeners) listener()
}

/** Delete-then-insert. */
function moved(
  list: readonly string[],
  source: string,
  target: string,
  position: DropPosition,
): string[] | undefined {
  if (source === target) return undefined
  const remaining = list.filter((value) => value !== source)
  const index = remaining.indexOf(target)
  if (index < 0) return undefined
  const insertAt = position === 'before' ? index : index + 1
  return [...remaining.slice(0, insertAt), source, ...remaining.slice(insertAt)]
}

/** The key a workspace is stored under: its stable id when the host has one, else its path. */
export function workspaceKey(workspace: Pick<WorkspaceEntry, 'workspaceId' | 'path'>): string {
  return workspace.workspaceId ?? workspace.path
}

/**
 * Projects in the user's saved order, then any project not saved yet in the order the daemon
 * returned. The managed chats workspace never joins this order; it is appended last because its
 * position in the array does not matter (it renders in its own section).
 */
export function orderWorkspaces(
  workspaces: readonly WorkspaceEntry[],
  saved: readonly string[] = order.workspaces,
): WorkspaceEntry[] {
  const byKey = new Map(workspaces.map((workspace) => [workspaceKey(workspace), workspace]))
  const ordered: WorkspaceEntry[] = []
  const used = new Set<string>()
  for (const key of saved) {
    const workspace = byKey.get(key)
    if (!workspace || workspace.kind === 'chats') continue
    ordered.push(workspace)
    used.add(key)
  }
  for (const workspace of workspaces) {
    const key = workspaceKey(workspace)
    if (used.has(key) || workspace.kind === 'chats') continue
    ordered.push(workspace)
    used.add(key)
  }
  for (const workspace of workspaces) if (workspace.kind === 'chats') ordered.push(workspace)
  return ordered
}

export const sidebarOrder = {
  getSnapshot: (): SidebarOrderSnapshot => order,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /**
   * `keys` is the effective project order currently on screen. Moving against it also materialises
   * it in storage, which is how a project that was never saved joins the record.
   */
  moveWorkspace(keys: readonly string[], source: string, target: string, position: DropPosition): void {
    const next = moved(keys, source, target, position)
    if (!next) return
    writeStored(WORKSPACE_KEY, next)
    publish({ workspaces: next })
  },
  reset(): void {
    try {
      localStorage.removeItem(WORKSPACE_KEY)
    } catch {
      /* nothing stored to remove */
    }
    publish({ workspaces: [] })
  },
}
