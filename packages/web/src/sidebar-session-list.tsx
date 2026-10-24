import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, EmptyState, Icon, IconButton, SettingsInput } from '@agnes/web-ui'
import { type ConversationItemType, Conversations, XProvider } from '@agnes/web-ui/x'
import {
  SIDEBAR_ORDER_ANNOUNCE_EVENT,
  type SidebarGroupState,
  type SidebarNavigationOptions,
  sortSessionsByRecency,
  untitledSessionLabel,
} from '@agnes/web-units/shell'
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { navigationHistory } from './navigation-history.js'
import type { SessionListMode } from './session-inventory.js'
import { SessionMenu } from './session-menu.js'
import { isCollapsed, isExpanded, setCollapsed, setExpanded } from './sidebar-collapse.js'
import { FolderIcon, NavigationLabel, workspaceLabel } from './sidebar-label.js'
import {
  type DropPosition,
  orderSections,
  orderWorkspaces,
  type SidebarSectionId,
  sidebarOrder,
  workspaceKey,
} from './sidebar-order.js'
import { WorkspaceMenu } from './workspace-menu.js'

type Row = SidebarNavigationOptions['sessions'][number]

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
const isPinned = (row: Row): boolean => !!row.pinnedAt && !row.archived

const byPinnedAt = (left: Row, right: Row): number => time(right.pinnedAt) - time(left.pinnedAt)

/** The daemon-managed chats workspace: its sessions form a group above the heading. */
const chatsPathOf = (workspaces: readonly WorkspaceEntry[]): string | undefined =>
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

/** The workspace a row belongs to, and the name it goes by in a flat list or a search. */
function workspaceNames(options: SidebarNavigationOptions, t: Translate) {
  const nameOf = (path: string | undefined): string => {
    const workspace = path ? options.workspaces.find((entry) => entry.path === path) : undefined
    if (workspace?.kind === 'chats') return t('nav.chats')
    if (workspace) return workspaceLabel(workspace)
    return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  }
  return { nameOf }
}

/**
 * One session row, shared by the paged list and the full-list views: title, running dot, the
 * workspace name and pin mark the flat list adds, the archived treatment, and the action menu.
 */
function SessionRowLabel({
  options,
  t,
  row,
  title,
  active,
  running,
  workspaceName,
  pinned,
  pinnedMark,
  archived,
  restoring,
  chats,
}: {
  options: SidebarNavigationOptions
  t: Translate
  row: Row
  title: string
  active: boolean
  running: boolean
  workspaceName?: string
  /** Offers 「Unpin」 in the menu; a grouped list shows that through its heading instead. */
  pinned: boolean
  /** The row-end pin mark, used only where no heading carries the pinned group. */
  pinnedMark: boolean
  archived: boolean
  restoring: boolean
  chats: boolean
}) {
  return (
    <>
      <Button
        appearance="ghost"
        className={active ? 'session active' : 'session'}
        disabled={options.disabled ?? false}
        data-session={row.sessionId}
        aria-current={active ? 'page' : undefined}
        title={title}
        onClick={() => options.open(row.sessionId)}
      >
        {running && <span className="session-running" role="img" aria-label={t('nav.running')} />}
        <span className="session-title">
          <NavigationLabel text={title} />
        </span>
        {workspaceName && <span className="session-workspace-label">{workspaceName}</span>}
        {pinnedMark && <Icon name="pin" className="session-pin-mark" />}
        {archived && (
          <>
            <Icon name="archive" className="session-archive-mark" />
            <span className="visually-hidden">{t('session.archived.badge')}</span>
          </>
        )}
      </Button>
      {archived && (
        <IconButton
          name="history"
          className="session-restore"
          data-testid="archived-restore"
          label={restoring ? t('session.archived.restoring') : t('session.archived.restoreAria', { title })}
          loading={restoring}
          disabled={restoring || (options.disabled ?? false)}
          aria-busy={restoring}
          onClick={() => void navigationHistory.restore(row.sessionId)}
        />
      )}
      {options.action && (
        <SessionMenu
          key={row.sessionId}
          id={row.sessionId}
          title={title}
          disabled={options.disabled ?? false}
          t={t}
          action={options.action}
          platform={options.runtimePlatform}
          chats={chats}
          pinned={pinned}
          archived={archived}
        />
      )}
    </>
  )
}

/** The drag behaviour a heading row offers: a handle, a drop target and a keyboard move. */
type HeadingDrag = {
  /** True while this row is the drag source; the row dims itself. */
  dragging?: boolean | undefined
  onDragStart(event: ReactDragEvent<HTMLElement>): void
  onDragEnd(): void
  onDragOver(event: ReactDragEvent<HTMLElement>): void
  onDragLeave(event: ReactDragEvent<HTMLElement>): void
  onDrop(event: ReactDragEvent<HTMLElement>): void
}

/**
 * One heading row for a section or a project: drag handle, icon, name, fold, and the right-side
 * actions. Sections and projects share the row and title classes so they read as one family;
 * a project adds `is-nested` for its extra indent.
 */
function SidebarSectionHeading({
  name,
  title,
  icon,
  collapsed,
  listId,
  onToggle,
  nested = false,
  actions,
  drag,
  dropPosition,
  onKeyDown,
}: {
  name: string
  title: string
  icon: ReactNode
  collapsed: boolean
  listId: string
  onToggle(): void
  nested?: boolean
  actions?: ReactNode
  drag?: HeadingDrag | undefined
  dropPosition?: DropPosition | undefined
  onKeyDown?: ((event: ReactKeyboardEvent<HTMLElement>) => void) | undefined
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only drop target; fold and Alt+Arrow live on its buttons.
    <div
      className={nested ? 'workspace-heading-row is-nested' : 'workspace-heading-row'}
      data-drop={dropPosition}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
    >
      <Button
        appearance="ghost"
        className="workspace-heading"
        aria-expanded={!collapsed}
        aria-controls={listId}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        title={title}
        // The name is the drag source: no separate handle sits in front of the heading.
        {...(drag ? { draggable: true, onDragStart: drag.onDragStart, onDragEnd: drag.onDragEnd } : {})}
        onClick={onToggle}
        onKeyDown={onKeyDown}
      >
        {icon}
        <span className="workspace-name">
          <NavigationLabel text={name} />
        </span>
      </Button>
      {actions}
    </div>
  )
}

const untitled = (options: SidebarNavigationOptions, t: Translate, row: Row, key: string) =>
  row.title ||
  options.labels.get(row.sessionId) ||
  untitledSessionLabel(t(key), row.createdAt, document.documentElement.lang || 'en')

/** One group in the sidebar: a paged group, a local bucket, or the synthesized pinned group. */
type SessionGroupView = InventoryGroup & { page?: SidebarGroupState }

/**
 * The paged view's groups in the order the server sent them; `kind` tells the leading sections
 * (pinned, chats) from the list under 「工作区」. Without a paged projection the groups are
 * bucketed locally and pinned sessions are lifted out of their folder.
 */
function sessionGroupViews(options: SidebarNavigationOptions): SessionGroupView[] {
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
function groupName(view: SessionGroupView, t: Translate): string {
  if (view.kind === 'pinned') return t('nav.pinned')
  if (view.kind === 'chats') return t('nav.chats')
  if (view.kind === 'unassigned') return t('session.uncategorized')
  return view.workspace ? workspaceLabel(view.workspace) : t('session.uncategorized')
}

/** A reserved collapse key per section, kept apart from real workspace paths and ids. */
const sectionCollapseKey = (id: SidebarSectionId): string => `__section__:${id}`

/** The toolbar-level live region lives in the shell; the navigation only announces the result. */
const announce = (message: string): void => {
  document.dispatchEvent(new CustomEvent<string>(SIDEBAR_ORDER_ANNOUNCE_EVENT, { detail: message }))
}

/**
 * The rows of one group plus its paging state and 「展开显示」 control. The section that owns the
 * heading decides whether the body is shown, so this stays a plain body for both the pinned and
 * chats sections and every project.
 */
function SessionGroupBody({
  options,
  t,
  view,
  redraw,
  collapsed,
  listId,
  rowItem,
  preSorted = false,
}: {
  options: SidebarNavigationOptions
  t: Translate
  view: SessionGroupView
  redraw(): void
  collapsed: boolean
  listId: string
  /** The full-list views render archived rows and restore actions; the paged view does not. */
  rowItem?: ((row: Row) => ConversationItemType) | undefined
  /** The full-list views already ordered rows by activity; do not re-sort them by creation. */
  preSorted?: boolean
}) {
  const { page, rows, id } = view
  const chatsPath = chatsPathOf(options.workspaces)
  const expanded = isExpanded(id)
  // Pinned rows are ordered by pin time, not activity; paged rows arrive in server order.
  const sorted = page || view.kind === 'pinned' || preSorted ? rows : sortSessionsByRecency(rows)
  const { shown, hidden } = page
    ? { shown: rows, hidden: Math.max(0, page.total - rows.length) }
    : shownSessions(sorted, expanded, options.currentId)
  const toggleable = page
    ? (!page.stale || page.loading) && page.loaded && (!!page.next || page.items.length > RECENT_SESSIONS)
    : sorted.length > RECENT_SESSIONS
  const pagedItem = (row: Row): ConversationItemType => {
    const title = untitled(options, t, row, 'nav.sessionFallback')
    const active = row.sessionId === options.currentId
    const running = options.runningIds?.includes(row.sessionId) ?? false
    return {
      key: row.sessionId,
      className: 'session-row',
      'data-active': String(active),
      label: (
        <SessionRowLabel
          options={options}
          t={t}
          row={row}
          title={title}
          active={active}
          running={running}
          pinned={!!row.pinnedAt}
          pinnedMark={false}
          archived={false}
          restoring={false}
          chats={!!chatsPath && row.cwd === chatsPath}
        />
      ),
    }
  }
  const renderRow = rowItem ?? pagedItem
  return (
    <div id={listId} className="workspace-sessions" hidden={collapsed} aria-busy={page?.loading}>
      {!collapsed && rows.length > 0 && (
        <Conversations
          className="session-conversations"
          {...(options.currentId ? { activeKey: options.currentId } : {})}
          items={shown.map(renderRow)}
        />
      )}
      {!collapsed && page && (
        <>
          {page.loading && !page.loaded && <p role="status">{t('nav.loading')}</p>}
          {!page.ready && <p role="status">{t('nav.initializing')}</p>}
          {!page.loading && (page.error || page.stale) && (
            <p role={page.error ? 'alert' : 'status'}>
              {page.error ?? t('nav.updated')}{' '}
              <Button
                size="small"
                disabled={page.loading}
                onClick={() => options.groupAction?.(id, page.stale ? 'reload' : 'retry')}
              >
                {t(page.stale ? 'nav.reload' : 'nav.retry')}
              </Button>
            </p>
          )}
          {page.loaded && page.items.length === 0 && !page.loading && (
            <p className="session-group-empty">{t('nav.empty.title')}</p>
          )}
        </>
      )}
      {!collapsed && toggleable && (
        <Button
          appearance="ghost"
          className="session-list-toggle"
          data-testid="workspace-sessions-toggle"
          data-workspace={id}
          aria-expanded={page ? page.items.length > RECENT_SESSIONS : expanded}
          disabled={page?.loading ?? false}
          onClick={() => {
            if (page) {
              options.groupAction?.(id, page.next ? 'more' : 'collapse')
              return
            }
            setExpanded(id, !expanded)
            redraw()
          }}
        >
          {(page ? !page.next : expanded) ? t('nav.showLess') : t('nav.showMore', { count: hidden })}
        </Button>
      )}
    </div>
  )
}

/** One project inside the workspace section: nested heading, rows and the project's menu. */
function SessionGroupSection({
  options,
  t,
  view,
  redraw,
  drag,
  dropPosition,
  onKeyDown,
  rowItem,
  preSorted = false,
}: {
  options: SidebarNavigationOptions
  t: Translate
  view: SessionGroupView
  redraw(): void
  drag?: HeadingDrag | undefined
  dropPosition?: DropPosition | undefined
  onKeyDown?: ((event: ReactKeyboardEvent<HTMLElement>) => void) | undefined
  rowItem?: ((row: Row) => ConversationItemType) | undefined
  preSorted?: boolean
}) {
  const { page, rows, id } = view
  const name = groupName(view, t)
  const workspace = view.workspace
  // The managed chats workspace is a group of chats, not a folder the user chose.
  const chats = workspace?.kind === 'chats'
  const pinned = view.kind === 'pinned'
  const collapsed = page ? !page.opened : isCollapsed(id)
  const listId = `workspace-sessions-${encodeURIComponent(id)}`
  return (
    <section className="workspace-group is-nested" data-dragging={drag?.dragging ? 'true' : undefined}>
      <SidebarSectionHeading
        name={name}
        title={pinned || chats ? name : (workspace?.path ?? t('nav.noWorkspaceTitle'))}
        icon={
          <>
            <FolderIcon className="icon icon-folder icon-folder-closed" />
            <FolderIcon open className="icon icon-folder icon-folder-open" />
          </>
        }
        collapsed={collapsed}
        listId={listId}
        nested
        drag={drag}
        dropPosition={dropPosition}
        onKeyDown={onKeyDown}
        actions={
          workspace ? (
            <WorkspaceMenu
              workspace={workspace}
              name={name}
              t={t}
              platform={options.runtimePlatform}
              disabled={options.disabled ?? false}
              newDisabled={(options.newDisabled ?? false) || !workspace.available}
              runningCount={rows.filter((row) => options.runningIds?.includes(row.sessionId)).length}
              newSession={() => options.newSession(workspace)}
              action={options.workspaceAction}
              managed={chats}
            />
          ) : undefined
        }
        onToggle={() => {
          if (page) {
            options.groupAction?.(id, 'toggle')
            return
          }
          setCollapsed(id, !collapsed)
          redraw()
        }}
      />
      <SessionGroupBody
        options={options}
        t={t}
        view={view}
        redraw={redraw}
        collapsed={collapsed}
        listId={listId}
        rowItem={rowItem}
        preSorted={preSorted}
      />
    </section>
  )
}

/** One of the three peer sections: 置顶 / 临时会话 / 工作区. */
type SidebarSectionView = {
  id: SidebarSectionId
  title: string
  icon: ReactNode
  /** The pinned or chats group rendered directly under the section heading. */
  group?: SessionGroupView
  /** The project groups inside the workspace section. */
  groups: SessionGroupView[]
}

const workspaceRank = (view: SessionGroupView, rank: ReadonlyMap<string, number>): number => {
  if (view.kind === 'unassigned' || !view.workspace) return Number.MAX_SAFE_INTEGER
  return rank.get(workspaceKey(view.workspace)) ?? Number.MAX_SAFE_INTEGER - 1
}

/**
 * The three sections in a fixed membership: pinned and chats hold one group each, workspaces holds
 * every project. Empty sections are left out. The order of the sections themselves comes from the
 * order store at render time, not from this list.
 */
function sectionViews(
  views: readonly SessionGroupView[],
  workspaces: readonly WorkspaceEntry[],
  t: Translate,
): SidebarSectionView[] {
  const hasRows = (view: SessionGroupView): boolean =>
    view.page ? view.page.total > 0 : view.rows.length > 0
  const pinned = views.find((view) => view.kind === 'pinned')
  const chats = views.find((view) => view.kind === 'chats')
  const rank = new Map(workspaces.map((workspace, index) => [workspaceKey(workspace), index]))
  // Registered folders stay visible while empty; an empty 「未分类」 bucket has nothing to say.
  const projects = views
    .filter((view) => !isLeadingKind(view.kind))
    .filter((view) => view.kind !== 'unassigned' || hasRows(view))
    .sort((left, right) => workspaceRank(left, rank) - workspaceRank(right, rank))
  const sections: SidebarSectionView[] = []
  if (pinned && hasRows(pinned))
    sections.push({
      id: 'pinned',
      title: t('nav.pinned'),
      icon: <Icon name="pin" className="icon icon-pinned" />,
      group: pinned,
      groups: [],
    })
  if (chats && hasRows(chats))
    sections.push({
      id: 'chats',
      title: t('nav.chats'),
      icon: <Icon name="message-square" className="icon icon-chats" />,
      group: chats,
      groups: [],
    })
  if (projects.length)
    sections.push({
      id: 'workspaces',
      title: t('sidebar.sectionHeading'),
      icon: <FolderIcon className="icon icon-folder" />,
      groups: projects,
    })
  return sections
}

type DragState = {
  kind: 'section' | 'workspace'
  id: string
  /** The dragged row's display name, so the announcement names the item that moved. */
  name: string
  targetId?: string | undefined
  position: DropPosition
}

/**
 * The grouped sidebar: three peer sections, each folding its own body, and reorderable by pointer
 * or keyboard. Both the paged projection and the full-list views render through here, so the
 * structure and the saved order stay identical across every filter.
 */
function GroupedSections({
  options,
  t,
  views,
  workspaces,
  redraw,
  rowItem,
  preSorted = false,
}: {
  options: SidebarNavigationOptions
  t: Translate
  views: readonly SessionGroupView[]
  workspaces: readonly WorkspaceEntry[]
  redraw(): void
  rowItem?: ((row: Row) => ConversationItemType) | undefined
  preSorted?: boolean
}) {
  const snapshot = useSyncExternalStore(sidebarOrder.subscribe, sidebarOrder.getSnapshot)
  const [drag, setDrag] = useState<DragState>()

  const sections = sectionViews(views, workspaces, t)
  const present = sections.map((section) => section.id)
  const ordered = orderSections(present, snapshot.sections)
  const sectionOf = new Map(sections.map((section) => [section.id, section]))
  // The chats workspace stays in `workspaces` for the chats section but never joins the saved order.
  const projects = workspaces.filter((workspace) => workspace.kind !== 'chats')
  const projectKeys = projects.map(workspaceKey)

  const movedTo = (kind: DragState['kind'], id: string): number =>
    kind === 'section'
      ? orderSections(present, sidebarOrder.getSnapshot().sections).indexOf(id as SidebarSectionId) + 1
      : orderWorkspaces(workspaces, sidebarOrder.getSnapshot().workspaces).map(workspaceKey).indexOf(id) + 1

  const announceMove = (kind: DragState['kind'], id: string, name: string): void => {
    announce(t('sidebar.order.moved', { name, position: movedTo(kind, id) }))
  }

  const dragStart =
    (kind: DragState['kind'], id: string, name: string) => (event: ReactDragEvent<HTMLElement>) => {
      event.dataTransfer?.setData('text/plain', id)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      setDrag({ kind, id, name, position: 'after' })
    }
  const dragEnd = () => setDrag(undefined)
  const dragOver = (kind: DragState['kind'], id: string) => (event: ReactDragEvent<HTMLElement>) => {
    if (!drag || drag.kind !== kind || drag.id === id) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    const position: DropPosition = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    setDrag((current) =>
      current && (current.targetId !== id || current.position !== position)
        ? { ...current, targetId: id, position }
        : current,
    )
  }
  const dragLeave = (kind: DragState['kind'], id: string) => (event: ReactDragEvent<HTMLElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDrag((current) =>
      current && current.kind === kind && current.targetId === id
        ? { ...current, targetId: undefined }
        : current,
    )
  }
  const drop = (kind: DragState['kind'], id: string) => (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    const current = drag
    setDrag(undefined)
    if (!current || current.kind !== kind || current.id === id) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const position: DropPosition =
      current.targetId === id
        ? current.position
        : event.clientY < bounds.top + bounds.height / 2
          ? 'before'
          : 'after'
    if (kind === 'section')
      sidebarOrder.moveSection(current.id as SidebarSectionId, id as SidebarSectionId, position)
    else sidebarOrder.moveWorkspace(projectKeys, current.id, id, position)
    announceMove(kind, current.id, current.name)
  }

  /** Alt+Arrow moves the focused heading one place; the live region reads the new position. */
  const keyMove =
    (kind: DragState['kind'], id: string, list: readonly string[], name: string) =>
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      const index = list.indexOf(id)
      const target = index < 0 ? undefined : list[index + (event.key === 'ArrowUp' ? -1 : 1)]
      if (!target) return
      const position: DropPosition = event.key === 'ArrowUp' ? 'before' : 'after'
      if (kind === 'section')
        sidebarOrder.moveSection(id as SidebarSectionId, target as SidebarSectionId, position)
      else sidebarOrder.moveWorkspace(projectKeys, id, target, position)
      announceMove(kind, id, name)
    }

  const toggleSection = (section: SidebarSectionView): void => {
    if (section.group?.page) {
      options.groupAction?.(section.group.id, 'toggle')
      return
    }
    const key = sectionCollapseKey(section.id)
    setCollapsed(key, !isCollapsed(key))
    redraw()
  }

  const renderProject = (view: SessionGroupView) => {
    const key = view.workspace ? workspaceKey(view.workspace) : undefined
    const draggable = !!key && view.kind === 'workspace'
    const name = groupName(view, t)
    return (
      <SessionGroupSection
        key={view.id}
        options={options}
        t={t}
        view={view}
        redraw={redraw}
        rowItem={rowItem}
        preSorted={preSorted}
        {...(draggable && key
          ? {
              drag: {
                dragging: drag?.kind === 'workspace' && drag.id === key,
                onDragStart: dragStart('workspace', key, name),
                onDragEnd: dragEnd,
                onDragOver: dragOver('workspace', key),
                onDragLeave: dragLeave('workspace', key),
                onDrop: drop('workspace', key),
              },
              ...(drag?.kind === 'workspace' && drag.targetId === key ? { dropPosition: drag.position } : {}),
              onKeyDown: keyMove('workspace', key, projectKeys, name),
            }
          : {})}
      />
    )
  }

  return (
    <>
      {ordered.map((id) => {
        const section = sectionOf.get(id)
        if (!section) return null
        const collapsed = section.group?.page
          ? !section.group.page.opened
          : isCollapsed(sectionCollapseKey(section.id))
        const listId = `sidebar-section-${section.id}`
        const chatsWorkspace = section.id === 'chats' ? section.group?.workspace : undefined
        return (
          <section
            key={section.id}
            className="sidebar-section"
            data-section={section.id}
            data-dragging={drag?.kind === 'section' && drag.id === section.id ? 'true' : undefined}
          >
            <SidebarSectionHeading
              name={section.title}
              title={section.title}
              icon={section.icon}
              collapsed={collapsed}
              listId={listId}
              actions={
                chatsWorkspace ? (
                  <WorkspaceMenu
                    workspace={chatsWorkspace}
                    name={section.title}
                    t={t}
                    platform={options.runtimePlatform}
                    disabled={options.disabled ?? false}
                    newDisabled={(options.newDisabled ?? false) || !chatsWorkspace.available}
                    runningCount={
                      section.group?.rows.filter((row) => options.runningIds?.includes(row.sessionId))
                        .length ?? 0
                    }
                    newSession={() => options.newSession(chatsWorkspace)}
                    action={options.workspaceAction}
                    managed
                  />
                ) : undefined
              }
              drag={{
                dragging: drag?.kind === 'section' && drag.id === section.id,
                onDragStart: dragStart('section', section.id, section.title),
                onDragEnd: dragEnd,
                onDragOver: dragOver('section', section.id),
                onDragLeave: dragLeave('section', section.id),
                onDrop: drop('section', section.id),
              }}
              {...(drag?.kind === 'section' && drag.targetId === section.id
                ? { dropPosition: drag.position }
                : {})}
              onKeyDown={keyMove('section', section.id, ordered, section.title)}
              onToggle={() => toggleSection(section)}
            />
            <div id={listId} className="sidebar-section-body" hidden={collapsed}>
              {!collapsed && section.group && (
                <SessionGroupBody
                  options={options}
                  t={t}
                  view={section.group}
                  redraw={redraw}
                  collapsed={false}
                  listId={listId}
                  rowItem={rowItem}
                  preSorted={preSorted}
                />
              )}
              {!collapsed && section.groups.map(renderProject)}
            </div>
          </section>
        )
      })}
    </>
  )
}

/**
 * The paged list the default view uses: one folder per workspace, newest session first inside it.
 * The pinned and chats groups come first in their own sections, and every section folds its body.
 * Rows are an Ant Design X Conversations list holding our own button and action menu, so focus,
 * `aria-current` and menu keyboard behaviour are unchanged contracts.
 */
export function WorkspaceSessions({ options, t }: { options: SidebarNavigationOptions; t: Translate }) {
  const [, redraw] = useState(0)
  const snapshot = useSyncExternalStore(sidebarOrder.subscribe, sidebarOrder.getSnapshot)
  // One default order for every filter: the daemon's workspace order, reordered by the user.
  const workspaces = orderWorkspaces(options.workspaces, snapshot.workspaces)
  const ordered = workspaces === options.workspaces ? options : { ...options, workspaces }
  const views = sessionGroupViews(ordered)
  const count = ordered.paging
    ? ordered.paging.groups.reduce((sum, group) => sum + group.total, 0)
    : ordered.sessions.filter((row) => !row.archived).length
  return (
    <>
      {ordered.paging && (!ordered.paging.ready || ordered.paging.error) && (
        <p role={ordered.paging.error ? 'alert' : 'status'}>
          {ordered.paging.error ??
            t(
              ordered.paging.groups.some((group) => group.initializationError)
                ? 'nav.initializationFailed'
                : 'nav.initializing',
            )}{' '}
          <Button size="small" disabled={ordered.paging.loading} onClick={ordered.refreshGroups}>
            {t('nav.retry')}
          </Button>
        </p>
      )}
      <XProvider>
        <GroupedSections
          options={ordered}
          t={t}
          views={views}
          workspaces={workspaces}
          redraw={() => redraw((value) => value + 1)}
        />
      </XProvider>
      {count === 0 && (!ordered.paging || (ordered.paging.ready && !ordered.paging.error)) && (
        <EmptyState
          className="session-list-empty"
          icon={<Icon name="message-square" />}
          title={t('nav.empty.title')}
          description={t('nav.empty.description')}
        />
      )}
      {!ordered.paging && ordered.next && ordered.loadMore && (
        <Button
          disabled={ordered.disabled ?? false}
          onClick={() => {
            if (ordered.next) ordered.loadMore?.(ordered.next)
          }}
        >
          {t('nav.loadMore')}
        </Button>
      )}
    </>
  )
}

/**
 * The full-list views: a flat list, everything including archived sessions, or the archived ones
 * alone. These modes need the whole list to get the order right, so they read it once and then
 * follow the inventory's invalidation instead of the paged projection.
 */
export function InventorySessions({
  options,
  t,
  mode,
  grouped,
  leading = false,
}: {
  options: SidebarNavigationOptions
  t: Translate
  mode: SessionListMode
  grouped: boolean
  leading?: boolean
}) {
  const history = navigationHistory
  const view = useSyncExternalStore(history.subscribe, history.getSnapshot)
  const snapshot = useSyncExternalStore(sidebarOrder.subscribe, sidebarOrder.getSnapshot)
  const [query, setQuery] = useState('')
  const [, redraw] = useState(0)
  const { nameOf } = workspaceNames(options, t)
  // Read the list once and again whenever the inventory publishes a fresh (stale) snapshot;
  // `ensureLoaded` itself does nothing while a read is in flight, loaded, or failed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the snapshot is the invalidation signal
  useEffect(() => {
    void history.ensureLoaded?.()
  }, [history, view])
  const searching = mode === 'archived'
  const needle = searching ? query.trim().toLocaleLowerCase() : ''
  const chatsPath = chatsPathOf(options.workspaces)
  const workspaces = orderWorkspaces(options.workspaces, snapshot.workspaces)
  const rows = sortSessionsByActivity(
    view.rows.filter(
      (row) => !needle || `${row.title ?? ''} ${nameOf(row.cwd)}`.toLocaleLowerCase().includes(needle),
    ),
  )
  const groups = grouped ? groupInventoryRows(rows, workspaces) : []
  const leadingFlat = leading ? flatLeadingRows(rows, options.workspaces) : []
  const mainFlat = flatMainRows(rows, options.workspaces)
  const firstRead = view.status === 'loading' && view.rows.length === 0
  const item = (row: Row, showWorkspace: boolean): ConversationItemType => {
    const title = untitled(
      options,
      t,
      row,
      mode === 'archived' ? 'session.archived.unnamed' : 'nav.sessionFallback',
    )
    const active = row.sessionId === options.currentId
    const archived = !!row.archived
    return {
      key: row.sessionId,
      className: 'session-row',
      'data-active': String(active),
      'data-archived': archived ? 'true' : undefined,
      label: (
        <SessionRowLabel
          options={options}
          t={t}
          row={row}
          title={title}
          active={active}
          running={!archived && (options.runningIds?.includes(row.sessionId) ?? false)}
          {...(showWorkspace ? { workspaceName: nameOf(row.cwd) || t('session.uncategorized') } : {})}
          pinned={isPinned(row)}
          pinnedMark={!grouped && isPinned(row)}
          archived={archived}
          restoring={view.restoring.includes(row.sessionId)}
          chats={!!chatsPath && row.cwd === chatsPath}
        />
      ),
    }
  }
  if (leading) {
    if (!leadingFlat.length) return null
    return (
      <div className="sidebar-leading">
        <XProvider>
          <Conversations
            className="session-conversations"
            {...(options.currentId ? { activeKey: options.currentId } : {})}
            items={leadingFlat.map((row) => item(row, true))}
          />
        </XProvider>
      </div>
    )
  }
  const empty = view.status !== 'loading' && !view.error && rows.length === 0
  return (
    <section
      className="sidebar-inventory"
      data-testid="session-inventory"
      aria-busy={view.status === 'loading'}
    >
      {searching && (
        <div className="sidebar-inventory-search">
          <Icon name="search" />
          <SettingsInput
            type="search"
            aria-label={t('home.archived.search')}
            autoComplete="off"
            data-testid="archived-search"
            placeholder={t('home.archived.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {firstRead && (
        <p className="sidebar-inventory-loading" role="status">
          {t(mode === 'archived' ? 'home.archived.loading' : 'home.archived.loadingAll')}
        </p>
      )}
      {view.error && (
        <p className="sidebar-inventory-error" role="alert">
          {view.error}{' '}
          <Button size="small" onClick={() => void history.reload()}>
            {t('home.archived.retry')}
          </Button>
        </p>
      )}
      <XProvider>
        {grouped ? (
          <GroupedSections
            options={options}
            t={t}
            views={groups}
            workspaces={workspaces}
            redraw={() => redraw((value) => value + 1)}
            rowItem={(row) => item(row, false)}
            preSorted
          />
        ) : (
          mainFlat.length > 0 && (
            <Conversations
              className="session-conversations"
              {...(options.currentId ? { activeKey: options.currentId } : {})}
              items={mainFlat.map((row) => item(row, true))}
            />
          )
        )}
      </XProvider>
      {empty &&
        (mode === 'archived' ? (
          <EmptyState
            className="session-list-empty"
            icon={<Icon name="history" />}
            title={t(needle ? 'session.archived.empty.noMatch' : 'session.archived.empty.fallback')}
            description={needle ? undefined : t('home.archived.emptyHelp')}
            actions={
              needle ? undefined : (
                <Button size="small" onClick={() => void history.setMode?.('active')}>
                  {t('home.archived.showActive')}
                </Button>
              )
            }
          />
        ) : (
          <EmptyState
            className="session-list-empty"
            icon={<Icon name="message-square" />}
            title={t('nav.empty.title')}
            description={t('nav.empty.description')}
          />
        ))}
    </section>
  )
}
