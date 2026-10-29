import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import type { SidebarGroupState, SidebarNavigationOptions } from '@agnes/web-units/shell'
import { workspaceLabel } from './sidebar-label.js'
import type { SidebarSectionId } from './sidebar-order.js'

export type Row = SidebarNavigationOptions['sessions'][number]

/** How many sessions a workspace shows before 「Show more」. */
export const RECENT_SESSIONS = 5

/**
 * The sessions a workspace shows: the most recent few, unless expanded. The open session always
 * shows, in its place, even when it is older than those.
 */
export function shownSessions<T extends { sessionId: string }>(
  sorted: readonly T[],
  expanded: boolean,
  currentId: string | undefined,
): { shown: T[]; hidden: number } {
  if (expanded || sorted.length <= RECENT_SESSIONS) return { shown: [...sorted], hidden: 0 }
  const shown = sorted.filter((row, index) => index < RECENT_SESSIONS || row.sessionId === currentId)
  return { shown, hidden: sorted.length - shown.length }
}

const time = (value: string | undefined): number => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
}

/**
 * Newest activity first: the last message when the list reports one, else when the session
 * started. Stable, so rows with no readable time keep the server's order.
 */
export function sortSessionsByActivity<Row extends { lastMessageAt?: string; createdAt?: string }>(
  rows: readonly Row[],
): Row[] {
  return rows
    .map((row, index) => ({
      row,
      index,
      time: row.lastMessageAt ? time(row.lastMessageAt) : time(row.createdAt),
    }))
    .sort((left, right) => (left.time === right.time ? left.index - right.index : right.time - left.time))
    .map((entry) => entry.row)
}

/** A pinned row belongs above the list; archives and pins are mutually exclusive. */
export const isPinned = (row: Row): boolean => !!row.pinnedAt && !row.archived

const byPinnedAt = (left: Row, right: Row): number => time(right.pinnedAt) - time(left.pinnedAt)

/** The daemon-managed chats workspace: its sessions form a group above the heading. */
export const chatsPathOf = (workspaces: readonly WorkspaceEntry[]): string | undefined =>
  workspaces.find((workspace) => workspace.kind === 'chats')?.path

export type InventoryGroup = Readonly<{
  id: string
  kind: 'pinned' | 'chats' | 'workspace' | 'unassigned'
  workspace?: WorkspaceEntry
  rows: readonly Row[]
}>

/** Groups that render in their own sidebar section instead of under 「工作区」. */
export const isLeadingKind = (kind: InventoryGroup['kind']): boolean => kind === 'pinned' || kind === 'chats'

/**
 * The grouped shape of a full-list view: pinned sessions first, then one group per registered
 * workspace in the sidebar's order, then everything whose folder is no longer registered.
 * The chats workspace is its own kind, so the view can lift it above the heading. Empty groups
 * are dropped, so an archived filter never leaves an empty heading behind.
 */
export function groupInventoryRows(
  rows: readonly Row[],
  workspaces: readonly WorkspaceEntry[],
): InventoryGroup[] {
  const groups: InventoryGroup[] = []
  const pinned = rows.filter(isPinned).sort(byPinnedAt)
  if (pinned.length) groups.push({ id: 'pinned', kind: 'pinned', rows: pinned })
  const buckets = new Map(workspaces.map((workspace) => [workspace.path, [] as Row[]]))
  const unassigned: Row[] = []
  for (const row of rows) {
    if (isPinned(row)) continue
    const bucket = row.cwd ? buckets.get(row.cwd) : undefined
    ;(bucket ?? unassigned).push(row)
  }
  for (const workspace of workspaces) {
    const bucket = buckets.get(workspace.path) ?? []
    if (bucket.length)
      groups.push({
        id: workspace.path,
        kind: workspace.kind === 'chats' ? 'chats' : 'workspace',
        workspace,
        rows: bucket,
      })
  }
  if (unassigned.length) groups.push({ id: '', kind: 'unassigned', rows: unassigned })
  return groups
}

/**
 * Flat rows above the heading: pinned sessions (newest pin first), then the chats workspace's
 * sessions in the order the activity sort gave them.
 */
export function flatLeadingRows(rows: readonly Row[], workspaces: readonly WorkspaceEntry[]): Row[] {
  const chats = chatsPathOf(workspaces)
  return [
    ...rows.filter(isPinned).sort(byPinnedAt),
    ...rows.filter((row) => !isPinned(row) && !!chats && row.cwd === chats),
  ]
}

/** Flat rows under the heading: everything that is neither pinned nor in the chats workspace. */
export function flatMainRows(rows: readonly Row[], workspaces: readonly WorkspaceEntry[]): Row[] {
  const chats = chatsPathOf(workspaces)
  return rows.filter((row) => !isPinned(row) && !(chats && row.cwd === chats))
}

/** One group in the sidebar: a paged group, a local bucket, or the synthesized pinned group. */
export type SessionGroupView = InventoryGroup & { page?: SidebarGroupState }

/**
 * The paged view's groups in the order the server sent them; `kind` tells the leading sections
 * (pinned, chats) from the list under 「工作区」. Without a paged projection the groups are
 * bucketed locally and pinned sessions are lifted out of their folder.
 */
export function sessionGroupViews(options: SidebarNavigationOptions): SessionGroupView[] {
  const views: SessionGroupView[] = []
  if (options.paging) {
    const workspaceOf = (groupId: string, workspaceId: string | undefined) =>
      options.workspaces.find((entry) =>
        workspaceId ? entry.workspaceId === workspaceId : entry.path === groupId,
      )
    for (const group of options.paging.groups) {
      const workspace =
        group.groupId === 'pinned' || group.groupId === 'unassigned'
          ? undefined
          : workspaceOf(group.groupId, group.workspaceId)
      views.push({
        id: group.groupId,
        kind:
          group.groupId === 'pinned'
            ? 'pinned'
            : workspace?.kind === 'chats'
              ? 'chats'
              : workspace
                ? 'workspace'
                : 'unassigned',
        ...(workspace ? { workspace } : {}),
        rows: group.items,
        page: group,
      })
    }
    return views
  }
  // Sessions whose folder is no longer registered collect in a last, unnamed-workspace folder.
  const buckets = new Map(options.workspaces.map((workspace) => [workspace.path, [] as Row[]]))
  const pinned: Row[] = []
  const unassigned: Row[] = []
  for (const row of options.sessions) {
    if (row.archived) continue
    if (isPinned(row)) pinned.push(row)
    else (buckets.get(row.cwd ?? '') ?? unassigned).push(row)
  }
  if (pinned.length) views.push({ id: 'pinned', kind: 'pinned', rows: pinned.sort(byPinnedAt) })
  for (const workspace of options.workspaces) {
    const rows = buckets.get(workspace.path) ?? []
    // An empty chats workspace has nothing to show in its own section.
    if (workspace.kind === 'chats' && !rows.length) continue
    views.push({
      id: workspace.path,
      kind: workspace.kind === 'chats' ? 'chats' : 'workspace',
      workspace,
      rows,
    })
  }
  if (unassigned.length) views.push({ id: '', kind: 'unassigned', rows: unassigned })
  return views
}

/** The name a group goes by, shared by the heading and the move announcement. */
export function groupName(view: SessionGroupView, t: Translate): string {
  if (view.kind === 'pinned') return t('nav.pinned')
  if (view.kind === 'chats') return t('nav.chats')
  if (view.kind === 'unassigned') return t('session.uncategorized')
  return view.workspace ? workspaceLabel(view.workspace) : t('session.uncategorized')
}

/** A reserved collapse key per section, kept apart from real workspace paths and ids. */
export const sectionCollapseKey = (id: SidebarSectionId): string => `__section__:${id}`
