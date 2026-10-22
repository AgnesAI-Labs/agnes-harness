/**
 * Which workspace folders the sidebar shows collapsed, and which show every session instead of
 * the newest few. Both live in module state so they survive navigation rebuilds, and in local
 * storage so they survive reloads. Components read through these helpers and re-render locally.
 */
const COLLAPSED_KEY = 'agnes.sidebar.collapsed-workspaces.v1'
const EXPANDED_KEY = 'agnes.sidebar.expanded-workspaces.v1'

function readPaths(key: string): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((path) => typeof path === 'string') : [])
  } catch {
    return new Set()
  }
}

function savePaths(key: string, paths: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...paths]))
  } catch {
    /* the in-memory record keeps working */
  }
}

const collapsedGroups = readPaths(COLLAPSED_KEY)
const expandedGroups = readPaths(EXPANDED_KEY)

export function isCollapsed(path: string): boolean {
  return collapsedGroups.has(path)
}

export function setCollapsed(path: string, value: boolean): void {
  if (value) collapsedGroups.add(path)
  else collapsedGroups.delete(path)
  savePaths(COLLAPSED_KEY, collapsedGroups)
}

export function isExpanded(path: string): boolean {
  return expandedGroups.has(path)
}

export function setExpanded(path: string, value: boolean): void {
  if (value) expandedGroups.add(path)
  else expandedGroups.delete(path)
  savePaths(EXPANDED_KEY, expandedGroups)
}

export function resetCollapsedGroups(): void {
  collapsedGroups.clear()
  savePaths(COLLAPSED_KEY, collapsedGroups)
}

export function resetExpandedGroups(): void {
  expandedGroups.clear()
  savePaths(EXPANDED_KEY, expandedGroups)
}
