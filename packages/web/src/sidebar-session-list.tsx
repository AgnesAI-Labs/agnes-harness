import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, EmptyState, Icon, IconButton, SettingsInput } from '@agnes/web-ui'
import { type ConversationItemType, Conversations, XProvider } from '@agnes/web-ui/x'
import {
  type SidebarNavigationOptions,
  sortSessionsByRecency,
  untitledSessionLabel,
} from '@agnes/web-units/shell'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { navigationHistory } from './navigation-history.js'
import type { SessionListMode } from './session-inventory.js'
import { SessionMenu } from './session-menu.js'
import { isCollapsed, isExpanded, setCollapsed, setExpanded } from './sidebar-collapse.js'
import { FolderIcon, NavigationLabel, workspaceLabel } from './sidebar-label.js'
import { WorkspaceMenu } from './workspace-menu.js'

type Row = SidebarNavigationOptions['sessions'][number]

/** How many sessions a workspace shows before 「展开显示」. */
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

export type InventoryGroup = Readonly<{
  id: string
  kind: 'pinned' | 'workspace' | 'unassigned'
  workspace?: WorkspaceEntry
  rows: readonly Row[]
}>

/**
 * The grouped shape of a full-list view: pinned sessions first, then one group per registered
 * workspace in the sidebar's order, then everything whose folder is no longer registered.
 * Empty groups are dropped, so an archived filter never leaves an empty heading behind.
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
    if (bucket.length) groups.push({ id: workspace.path, kind: 'workspace', workspace, rows: bucket })
  }
  if (unassigned.length) groups.push({ id: '', kind: 'unassigned', rows: unassigned })
  return groups
}

/** The flat shape of a full-list view: pinned sessions first, then everything by activity. */
export function flatInventoryRows(rows: readonly Row[]): Row[] {
  return [...rows.filter(isPinned).sort(byPinnedAt), ...rows.filter((row) => !isPinned(row))]
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
  /** Offers 「取消置顶」 in the menu; a grouped list shows that through its heading instead. */
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

/** The folder row both list shapes share: collapse, name, and the workspace's own menu. */
function WorkspaceGroupHeading({
  options,
  t,
  group,
  name,
  collapsed,
  listId,
  onToggle,
  runningCount,
}: {
  options: SidebarNavigationOptions
  t: Translate
  group: InventoryGroup
  name: string
  collapsed: boolean
  listId: string
  onToggle(): void
  runningCount: number
}) {
  const workspace = group.workspace
  // The managed chats workspace is a group of chats, not a folder the user chose.
  const chats = workspace?.kind === 'chats'
  const pinned = group.kind === 'pinned'
  return (
    <div className="workspace-heading-row">
      <Button
        appearance="ghost"
        className="workspace-heading"
        aria-expanded={!collapsed}
        aria-controls={listId}
        title={chats || pinned ? name : (workspace?.path ?? t('nav.noWorkspaceTitle'))}
        onClick={onToggle}
      >
        {pinned || chats ? (
          <Icon
            name={pinned ? 'pin' : 'message-square'}
            className={pinned ? 'icon icon-pinned' : 'icon icon-chats'}
          />
        ) : (
          <>
            <FolderIcon className="icon icon-folder icon-folder-closed" />
            <FolderIcon open className="icon icon-folder icon-folder-open" />
          </>
        )}
        <span className="workspace-name">
          <NavigationLabel text={name} />
        </span>
      </Button>
      {workspace && (
        <WorkspaceMenu
          workspace={workspace}
          name={name}
          t={t}
          platform={options.runtimePlatform}
          disabled={options.disabled ?? false}
          newDisabled={(options.newDisabled ?? false) || !workspace.available}
          runningCount={runningCount}
          newSession={() => options.newSession(workspace)}
          action={options.workspaceAction}
          managed={chats}
        />
      )}
    </div>
  )
}

const untitled = (options: SidebarNavigationOptions, t: Translate, row: Row, key: string) =>
  row.title ||
  options.labels.get(row.sessionId) ||
  untitledSessionLabel(t(key), row.createdAt, document.documentElement.lang || 'en')

/**
 * The paged list the default view uses: one folder per workspace, newest session first inside it.
 * A folder header collapses its sessions and carries the "new session here" action; rows are an
 * Ant Design X Conversations list holding our own button and action menu, so focus, `aria-current`
 * and menu keyboard behaviour are unchanged contracts.
 */
export function WorkspaceSessions({ options, t }: { options: SidebarNavigationOptions; t: Translate }) {
  const [, redraw] = useState(0)
  // Sessions whose folder is no longer registered collect in a last, unnamed-workspace folder.
  const groups = new Map<string, SidebarNavigationOptions['sessions']>()
  for (const workspace of options.workspaces) groups.set(workspace.path, [])
  groups.set('', [])
  let count = 0
  for (const row of options.sessions) {
    if (row.archived) continue
    count += 1
    ;(groups.get(row.cwd ?? '') ?? groups.get(''))?.push(row)
  }
  if (options.paging) {
    groups.clear()
    for (const group of options.paging.groups) groups.set(group.groupId, group.items)
    count = options.paging.groups.reduce((sum, group) => sum + group.total, 0)
  }
  const chatsPath = options.workspaces.find((entry) => entry.kind === 'chats')?.path
  const item = (row: Row): ConversationItemType => {
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
  return (
    <>
      {options.paging && (!options.paging.ready || options.paging.error) && (
        <p role={options.paging.error ? 'alert' : 'status'}>
          {options.paging.error ??
            t(
              options.paging.groups.some((group) => group.initializationError)
                ? 'nav.initializationFailed'
                : 'nav.initializing',
            )}{' '}
          <Button size="small" disabled={options.paging.loading} onClick={options.refreshGroups}>
            {t('nav.retry')}
          </Button>
        </p>
      )}
      <XProvider>
        {[...groups].map(([path, sessions]) => {
          if (!sessions.length && !path) return null
          const page = options.paging?.groups.find((group) => group.groupId === path)
          const pinned = page?.groupId === 'pinned'
          if ((page?.groupId === 'unassigned' || pinned) && page.total === 0) return null
          const workspace = pinned
            ? undefined
            : options.workspaces.find((entry) =>
                page ? entry.workspaceId === page.workspaceId : entry.path === path,
              )
          const name = pinned
            ? t('nav.pinned')
            : workspace
              ? workspace.kind === 'chats'
                ? t('nav.chats')
                : workspaceLabel(workspace)
              : t('session.uncategorized')
          const collapsed = page ? !page.opened : isCollapsed(path)
          const expanded = isExpanded(path)
          const sorted = page ? sessions : sortSessionsByRecency(sessions)
          const { shown, hidden } = page
            ? { shown: sessions, hidden: Math.max(0, page.total - sessions.length) }
            : shownSessions(sorted, expanded, options.currentId)
          const toggleable = page
            ? (!page.stale || page.loading) &&
              page.loaded &&
              (!!page.next || page.items.length > RECENT_SESSIONS)
            : sorted.length > RECENT_SESSIONS
          const listId = `workspace-sessions-${encodeURIComponent(path)}`
          return (
            <section key={path} className="workspace-group">
              <WorkspaceGroupHeading
                options={options}
                t={t}
                group={{
                  id: path,
                  kind: pinned ? 'pinned' : workspace ? 'workspace' : 'unassigned',
                  ...(workspace ? { workspace } : {}),
                  rows: sessions,
                }}
                name={name}
                collapsed={collapsed}
                listId={listId}
                runningCount={sessions.filter((row) => options.runningIds?.includes(row.sessionId)).length}
                onToggle={() => {
                  if (page) {
                    options.groupAction?.(path, 'toggle')
                    return
                  }
                  setCollapsed(path, !collapsed)
                  redraw((value) => value + 1)
                }}
              />
              <div id={listId} className="workspace-sessions" hidden={collapsed} aria-busy={page?.loading}>
                {!collapsed && sessions.length > 0 && (
                  <Conversations
                    className="session-conversations"
                    {...(options.currentId ? { activeKey: options.currentId } : {})}
                    items={shown.map(item)}
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
                          onClick={() => options.groupAction?.(path, page.stale ? 'reload' : 'retry')}
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
                    data-workspace={path}
                    aria-expanded={page ? page.items.length > RECENT_SESSIONS : expanded}
                    disabled={page?.loading ?? false}
                    onClick={() => {
                      if (page) {
                        options.groupAction?.(path, page.next ? 'more' : 'collapse')
                        return
                      }
                      setExpanded(path, !expanded)
                      redraw((value) => value + 1)
                    }}
                  >
                    {(page ? !page.next : expanded)
                      ? t('nav.showLess')
                      : t('nav.showMore', { count: hidden })}
                  </Button>
                )}
              </div>
            </section>
          )
        })}
      </XProvider>
      {count === 0 && (!options.paging || (options.paging.ready && !options.paging.error)) && (
        <EmptyState
          className="session-list-empty"
          icon={<Icon name="message-square" />}
          title={t('nav.empty.title')}
          description={t('nav.empty.description')}
        />
      )}
      {!options.paging && options.next && options.loadMore && (
        <Button
          disabled={options.disabled ?? false}
          onClick={() => {
            if (options.next) options.loadMore?.(options.next)
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
}: {
  options: SidebarNavigationOptions
  t: Translate
  mode: SessionListMode
  grouped: boolean
}) {
  const history = navigationHistory
  const view = useSyncExternalStore(history.subscribe, history.getSnapshot)
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
  const chatsPath = options.workspaces.find((entry) => entry.kind === 'chats')?.path
  const rows = sortSessionsByActivity(
    view.rows.filter(
      (row) => !needle || `${row.title ?? ''} ${nameOf(row.cwd)}`.toLocaleLowerCase().includes(needle),
    ),
  )
  const groups = grouped ? groupInventoryRows(rows, options.workspaces) : []
  const flat = grouped ? [] : flatInventoryRows(rows)
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
        {groups.map((group) => {
          const name =
            group.kind === 'pinned'
              ? t('nav.pinned')
              : group.kind === 'unassigned'
                ? t('session.uncategorized')
                : nameOf(group.workspace?.path)
          const collapsed = isCollapsed(group.id)
          const expanded = isExpanded(group.id)
          const { shown, hidden } = shownSessions(group.rows, expanded, options.currentId)
          const listId = `inventory-sessions-${encodeURIComponent(group.id)}`
          return (
            <section key={group.id} className="workspace-group">
              <WorkspaceGroupHeading
                options={options}
                t={t}
                group={group}
                name={name}
                collapsed={collapsed}
                listId={listId}
                runningCount={group.rows.filter((row) => options.runningIds?.includes(row.sessionId)).length}
                onToggle={() => {
                  setCollapsed(group.id, !collapsed)
                  redraw((value) => value + 1)
                }}
              />
              <div id={listId} className="workspace-sessions" hidden={collapsed}>
                {!collapsed && (
                  <Conversations
                    className="session-conversations"
                    {...(options.currentId ? { activeKey: options.currentId } : {})}
                    items={shown.map((row) => item(row, false))}
                  />
                )}
                {!collapsed && group.rows.length > RECENT_SESSIONS && (
                  <Button
                    appearance="ghost"
                    className="session-list-toggle"
                    data-testid="inventory-sessions-toggle"
                    data-workspace={group.id}
                    aria-expanded={expanded}
                    onClick={() => {
                      setExpanded(group.id, !expanded)
                      redraw((value) => value + 1)
                    }}
                  >
                    {expanded ? t('nav.showLess') : t('nav.showMore', { count: hidden })}
                  </Button>
                )}
              </div>
            </section>
          )
        })}
        {!grouped && flat.length > 0 && (
          <Conversations
            className="session-conversations"
            {...(options.currentId ? { activeKey: options.currentId } : {})}
            items={flat.map((row) => item(row, true))}
          />
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
      {/* `nameOf` is resolved per row above; nothing else lives at the section level. */}
    </section>
  )
}
