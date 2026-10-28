import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, EmptyState, Icon, SettingsInput } from '@agnes/web-ui'
import { type ConversationItemType, Conversations, XProvider } from '@agnes/web-ui/x'
import {
  SIDEBAR_ORDER_ANNOUNCE_EVENT,
  type SidebarNavigationOptions,
  sortSessionsByRecency,
} from '@agnes/web-units/shell'
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { navigationHistory } from './navigation-history.js'
import type { SessionListMode } from './session-inventory.js'
import { isCollapsed, isExpanded, setCollapsed, setExpanded } from './sidebar-collapse.js'
import {
  chatsPathOf,
  flatLeadingRows,
  flatMainRows,
  groupInventoryRows,
  groupName,
  isPinned,
  RECENT_SESSIONS,
  type Row,
  type SessionGroupView,
  sectionCollapseKey,
  sessionGroupViews,
  shownSessions,
  sortSessionsByActivity,
} from './sidebar-groups.js'
import { FolderIcon } from './sidebar-label.js'
import { type DropPosition, orderWorkspaces, sidebarOrder, workspaceKey } from './sidebar-order.js'
import {
  type HeadingDrag,
  SessionRowLabel,
  SidebarSectionHeading,
  type SidebarSectionView,
  sectionViews,
  untitled,
  workspaceNames,
} from './sidebar-rendering.js'
import { WorkspaceMenu } from './workspace-menu.js'

/**
 * Paged groups whose section fold has been applied, per sidebar (keyed by its group action). The
 * paged 置顶 / 临时会话 groups keep their open state in memory only; the section fold lives in the
 * collapse store, so the first time a group shows, its open state is set to match that fold.
 */
const foldApplied = new WeakMap<object, Set<string>>()

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
          mark={options.marks?.[row.sessionId]}
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
      {rows.length > 0 && (
        <Conversations
          className="session-conversations"
          {...(options.currentId ? { activeKey: options.currentId } : {})}
          items={shown.map(renderRow)}
        />
      )}
      {page && (
        <>
          {!page.loading && page.error && (
            <p role="alert">
              {page.error}{' '}
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
      {toggleable && (
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
        count={page ? page.total : rows.length}
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

type DragState = {
  id: string
  /** The dragged row's display name, so the announcement names the item that moved. */
  name: string
  targetId?: string | undefined
  position: DropPosition
}

/**
 * The grouped sidebar: three peer sections in a fixed order (置顶 → 项目 → 临时会话), each folding
 * its own body. Projects inside 项目 reorder by pointer or keyboard; the sections never move. Both
 * the paged projection and the full-list views render through here, so the structure and the
 * saved project order stay identical across every filter.
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
  const [drag, setDrag] = useState<DragState>()

  const sections = sectionViews(views, workspaces, t)
  // The chats workspace stays in `workspaces` for the chats section but never joins the saved order.
  const projects = workspaces.filter((workspace) => workspace.kind !== 'chats')
  const projectKeys = projects.map(workspaceKey)

  const announceMove = (id: string, name: string): void => {
    const position =
      orderWorkspaces(workspaces, sidebarOrder.getSnapshot().workspaces).map(workspaceKey).indexOf(id) + 1
    announce(t('sidebar.order.moved', { name, position }))
  }

  const dragStart = (id: string, name: string) => (event: ReactDragEvent<HTMLElement>) => {
    event.dataTransfer?.setData('text/plain', id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
    setDrag({ id, name, position: 'after' })
  }
  const dragEnd = () => setDrag(undefined)
  const dragOver = (id: string) => (event: ReactDragEvent<HTMLElement>) => {
    if (!drag || drag.id === id) return
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
  const dragLeave = (id: string) => (event: ReactDragEvent<HTMLElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDrag((current) => (current && current.targetId === id ? { ...current, targetId: undefined } : current))
  }
  const drop = (id: string) => (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault()
    const current = drag
    setDrag(undefined)
    if (!current || current.id === id) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const position: DropPosition =
      current.targetId === id
        ? current.position
        : event.clientY < bounds.top + bounds.height / 2
          ? 'before'
          : 'after'
    sidebarOrder.moveWorkspace(projectKeys, current.id, id, position)
    announceMove(current.id, current.name)
  }

  /** Alt+Arrow moves the focused project one place; the live region reads the new position. */
  const keyMove = (id: string, name: string) => (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const index = projectKeys.indexOf(id)
    const target = index < 0 ? undefined : projectKeys[index + (event.key === 'ArrowUp' ? -1 : 1)]
    if (!target) return
    sidebarOrder.moveWorkspace(projectKeys, id, target, event.key === 'ArrowUp' ? 'before' : 'after')
    announceMove(id, name)
  }

  // A paged section group folds through the pager; the effect below records the result.
  const toggleSection = (section: SidebarSectionView): void => {
    if (section.group?.page) {
      options.groupAction?.(section.group.id, 'toggle')
      return
    }
    const key = sectionCollapseKey(section.id)
    setCollapsed(key, !isCollapsed(key))
    redraw()
  }

  // Every section fold is remembered in this browser, the paged 置顶 / 临时会话 groups included:
  // on first sight a group is opened or closed to match the remembered fold, then the store
  // follows the group, whatever opened it (a click, or a new chat started in it).
  const groupAction = options.groupAction
  useEffect(() => {
    if (!groupAction) return
    const applied = foldApplied.get(groupAction) ?? new Set<string>()
    foldApplied.set(groupAction, applied)
    for (const section of sections) {
      const page = section.group?.page
      if (!section.group || !page) continue
      const key = sectionCollapseKey(section.id)
      if (!applied.has(section.group.id)) {
        applied.add(section.group.id)
        if (page.opened === isCollapsed(key)) groupAction(section.group.id, 'toggle')
      } else if (page.opened === isCollapsed(key)) setCollapsed(key, !page.opened)
    }
  })

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
                dragging: drag?.id === key,
                onDragStart: dragStart(key, name),
                onDragEnd: dragEnd,
                onDragOver: dragOver(key),
                onDragLeave: dragLeave(key),
                onDrop: drop(key),
              },
              ...(drag?.targetId === key ? { dropPosition: drag.position } : {}),
              onKeyDown: keyMove(key, name),
            }
          : {})}
      />
    )
  }

  return (
    <>
      {sections.map((section) => {
        const collapsed = section.group?.page
          ? !section.group.page.opened
          : isCollapsed(sectionCollapseKey(section.id))
        const listId = `sidebar-section-${section.id}`
        const chatsWorkspace = section.id === 'chats' ? section.group?.workspace : undefined
        return (
          <section key={section.id} className="sidebar-section" data-section={section.id}>
            <SidebarSectionHeading
              name={section.title}
              title={section.title}
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
                ) : section.id === 'workspaces' && options.headingTools ? (
                  <span className="sidebar-section-tools">{options.headingTools}</span>
                ) : undefined
              }
              onToggle={() => toggleSection(section)}
            />
            <div id={listId} className="sidebar-section-body" hidden={collapsed}>
              {section.group && (
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
              {section.groups.map(renderProject)}
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
          mark={archived ? undefined : options.marks?.[row.sessionId]}
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
