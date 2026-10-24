import type { WorkspaceEntry } from '@agnes/protocol'

/**
 * The user's own order for the sidebar: which section comes first, and which project comes first
 * inside the workspace section. Both live in local storage like the grouping and collapse records,
 * so they survive reloads but stay on this computer. Saved entries that no longer exist are kept
 * in storage but ignored when rendering; a move rewrites the effective order.
 */
export type SidebarSectionId = 'pinned' | 'chats' | 'workspaces'

export type DropPosition = 'before' | 'after'

export const DEFAULT_SECTION_ORDER: readonly SidebarSectionId[] = ['pinned', 'chats', 'workspaces']

const SECTION_KEY = 'agnes.sidebar.section-order.v1'
const WORKSPACE_KEY = 'agnes.sidebar.workspace-order.v1'

export type SidebarOrderSnapshot = {
  sections: readonly SidebarSectionId[]
  workspaces: readonly string[]
}

const isSectionId = (value: unknown): value is SidebarSectionId =>
  value === 'pinned' || value === 'chats' || value === 'workspaces'

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

/**
 * A stored section order always comes back as a full permutation of the three known sections:
 * unknown values and duplicates are dropped, and anything missing is appended in its default
 * position. Sections that are empty stay in the array, so showing or hiding one later does not
 * disturb the order the user chose.
 */
function cleanSections(saved: readonly string[]): SidebarSectionId[] {
  const seen = new Set<SidebarSectionId>()
  for (const value of saved) if (isSectionId(value) && !seen.has(value)) seen.add(value)
  for (const value of DEFAULT_SECTION_ORDER) if (!seen.has(value)) seen.add(value)
  return [...seen]
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

let order: SidebarOrderSnapshot = {
  sections: cleanSections(readStored(SECTION_KEY)),
  workspaces: unique(readStored(WORKSPACE_KEY)),
}
const listeners = new Set<() => void>()

function publish(next: SidebarOrderSnapshot): void {
  order = next
  for (const listener of listeners) listener()
}

/** Delete-then-insert, the one move both sections and projects use. */
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

/** The saved section order, restricted to the sections that currently exist. */
export function orderSections(
  present: readonly SidebarSectionId[],
  saved: readonly SidebarSectionId[] = order.sections,
): SidebarSectionId[] {
  const existing = new Set(present)
  return saved.filter((id) => existing.has(id))
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
  moveSection(id: SidebarSectionId, targetId: SidebarSectionId, position: DropPosition): void {
    const next = moved(order.sections, id, targetId, position) as SidebarSectionId[] | undefined
    if (!next) return
    writeStored(SECTION_KEY, next)
    publish({ ...order, sections: next })
  },
  /**
   * `keys` is the effective project order currently on screen. Moving against it also materialises
   * it in storage, which is how a project that was never saved joins the record.
   */
  moveWorkspace(keys: readonly string[], source: string, target: string, position: DropPosition): void {
    const next = moved(keys, source, target, position)
    if (!next) return
    writeStored(WORKSPACE_KEY, next)
    publish({ ...order, workspaces: next })
  },
  resetSections(): void {
    try {
      localStorage.removeItem(SECTION_KEY)
    } catch {
      /* nothing stored to remove */
    }
    publish({ ...order, sections: [...DEFAULT_SECTION_ORDER] })
  },
  resetWorkspaces(): void {
    try {
      localStorage.removeItem(WORKSPACE_KEY)
    } catch {
      /* nothing stored to remove */
    }
    publish({ ...order, workspaces: [] })
  },
  reset(): void {
    try {
      localStorage.removeItem(SECTION_KEY)
      localStorage.removeItem(WORKSPACE_KEY)
    } catch {
      /* nothing stored to remove */
    }
    publish({ sections: [...DEFAULT_SECTION_ORDER], workspaces: [] })
  },
}
