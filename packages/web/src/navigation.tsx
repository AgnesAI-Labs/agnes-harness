import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, EmptyState, Icon, IconButton, PushCrumbs, renderRegion, SettingsInput } from '@agnes/web-ui'
import { type ConversationItemType, Conversations, XProvider } from '@agnes/web-ui/x'
import { type SidebarNavigationOptions, sortSessionsByRecency, untitledSessionLabel } from '@agnes/web-units'
import { useState, useSyncExternalStore } from 'react'
import { archivedSessions } from './archived-sessions.js'
import { SessionMenu } from './session-menu.js'
import { WorkspaceMenu } from './workspace-menu.js'

const FOLDER_CLOSED =
  'M5.37012 2.8418C5.52719 2.84178 5.68146 2.88387 5.81641 2.96289C5.95148 3.04201 6.06232 3.15581 6.13672 3.29199L6.74414 4.40137H12.7383C13.2166 4.40139 13.6084 4.78249 13.6084 5.25391V12.6631C13.6082 13.1343 13.2165 13.5146 12.7383 13.5146H2.7627C2.28458 13.5146 1.89277 13.1343 1.89258 12.6631V3.69434C1.89258 3.22297 2.28447 2.84189 2.7627 2.8418H5.37012ZM2.83496 11.4932V12.5908H12.667V11.5645H12.666V8.00488L2.84961 7.99121L2.83496 11.4932ZM2.83496 7.06738H12.666V5.32617H6.18066L6.16016 5.28809L5.32715 3.76562H2.83496V7.06738Z'

const FOLDER_OPEN =
  'M14.8882 7.43937C14.7797 7.27754 14.6048 7.18094 14.4203 7.18094H13.0118V5.05978C13.0118 4.71287 12.7519 4.43062 12.4324 4.43062H7.94002L6.90381 3.20368C6.79449 3.07423 6.63884 3 6.47679 3H2.57931C2.25988 3 2 3.28223 2 3.62914V13.5309C2 13.784 2.19469 13.9892 2.43501 13.9894L12.5436 14C12.7867 14 13.0064 13.8332 13.0902 13.5849L14.9642 8.03053C15.0313 7.83148 15.003 7.61049 14.8882 7.43937ZM2.86667 12.1904V3.91258H6.34273L7.37891 5.1395C7.48823 5.26896 7.64389 5.3432 7.80597 5.3432H12.1451V7.18094H5.33423C5.1065 7.18094 4.89848 7.32662 4.80427 7.5521L2.86667 12.1904V12.1904ZM12.3382 13.0874H3.43876L5.52489 8.0935H14.0232L12.3382 13.0874V13.0874Z'

export function FolderIcon({
  open = false,
  className = 'icon icon-folder',
  region = false,
}: {
  open?: boolean
  className?: string
  region?: boolean
}) {
  return (
    <svg
      data-agnes-region={region ? 'icon' : undefined}
      className={className}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d={open ? FOLDER_OPEN : FOLDER_CLOSED} />
    </svg>
  )
}

export function workspaceLabel(workspace: WorkspaceEntry): string {
  return (
    workspace.name.trim() || workspace.path.split(/[\\/]/).filter(Boolean).at(-1)?.trim() || workspace.path
  )
}

export function WorkspaceOptions({
  workspaces,
  select,
}: {
  workspaces: readonly WorkspaceEntry[]
  select(workspace: WorkspaceEntry): void
}) {
  return (
    <>
      {workspaces.map((workspace) => (
        <Button
          key={workspace.path}
          className="workspace-option"
          data-available={String(workspace.available)}
          disabled={!workspace.available}
          onClick={() => select(workspace)}
        >
          <FolderIcon />
          <span className="workspace-option-copy">
            <span className="workspace-option-name">{workspaceLabel(workspace)}</span>
            <span className="workspace-option-path">{workspace.path}</span>
          </span>
        </Button>
      ))}
    </>
  )
}

export function renderWorkspaceOptions(
  container: HTMLElement,
  workspaces: readonly WorkspaceEntry[],
  select: (workspace: WorkspaceEntry) => void,
): void {
  renderRegion(container, <WorkspaceOptions workspaces={workspaces} select={select} />)
}

const COLLAPSED_KEY = 'agnes.sidebar.collapsed-workspaces.v1'

function readCollapsedGroups(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((path) => typeof path === 'string') : [])
  } catch {
    return new Set()
  }
}

// Folder collapse outlives navigation rebuilds (module state) and reloads (local storage).
const collapsedGroups = readCollapsedGroups()

function saveCollapsedGroups(): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedGroups]))
  } catch {
    /* the in-memory record keeps working */
  }
}

export function resetCollapsedGroups(): void {
  collapsedGroups.clear()
  saveCollapsedGroups()
}

/** How many sessions a workspace shows before 「展开显示」. */
export const RECENT_SESSIONS = 5
const EXPANDED_KEY = 'agnes.sidebar.expanded-workspaces.v1'

function readExpandedGroups(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]')
    return new Set(Array.isArray(saved) ? saved.filter((path) => typeof path === 'string') : [])
  } catch {
    return new Set()
  }
}

// Which workspaces show all their sessions, remembered on this computer like the folder collapse.
const expandedGroups = readExpandedGroups()

function saveExpandedGroups(): void {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedGroups]))
  } catch {
    /* the in-memory record keeps working */
  }
}

export function resetExpandedGroups(): void {
  expandedGroups.clear()
  saveExpandedGroups()
}

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

/** Archived sessions in one flat list: find one, put it back among the active sessions. */
function ArchivedSessions({ options, t }: { options: SidebarNavigationOptions; t: Translate }) {
  const view = useSyncExternalStore(archivedSessions.subscribe, archivedSessions.getSnapshot)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const name = (path: string | undefined) => {
    const workspace = options.workspaces.find((entry) => entry.path === path)
    return workspace ? workspaceLabel(workspace) : (path?.split(/[\\/]/).filter(Boolean).at(-1) ?? '')
  }
  const rows = sortSessionsByRecency(
    view.rows.filter((row) => `${row.title ?? ''} ${row.cwd ?? ''}`.toLocaleLowerCase().includes(needle)),
  )
  return (
    <section
      className="archived-sessions"
      data-testid="archived-sessions"
      aria-busy={view.status === 'loading'}
    >
      {/* The archived list is a view of the sessions list; the breadcrumb leads back to it. */}
      <PushCrumbs
        title={t('home.filter.archived')}
        crumbs={[t('sidebar.sectionHeading')]}
        backTestId="archived-back"
        onBack={() => archivedSessions.show('active')}
      />
      <div className="archived-search">
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
      {view.error && (
        <p className="archived-sessions-error" role="alert">
          {view.error}{' '}
          {view.status === 'error' && (
            <Button size="small" onClick={() => void archivedSessions.reload()}>
              {t('home.archived.retry')}
            </Button>
          )}
        </p>
      )}
      <ul className="archived-session-list">
        {rows.map((row) => {
          const title =
            row.title ||
            options.labels.get(row.sessionId) ||
            untitledSessionLabel(
              t('session.archived.unnamed'),
              row.createdAt,
              document.documentElement.lang || 'en',
            )
          const restoring = view.restoring.includes(row.sessionId)
          return (
            <li key={row.sessionId} className="archived-session" data-session={row.sessionId}>
              <span className="archived-session-copy">
                <span className="session-title" title={title}>
                  {title}
                </span>
                {row.cwd && <span className="archived-session-workspace">{name(row.cwd)}</span>}
              </span>
              <IconButton
                name="history"
                className="archived-session-restore"
                data-testid="archived-restore"
                label={t('session.archived.restoreAria', { title })}
                disabled={restoring}
                aria-busy={restoring}
                onClick={() => void archivedSessions.restore(row.sessionId)}
              />
            </li>
          )
        })}
      </ul>
      {view.status !== 'loading' && rows.length === 0 && view.status !== 'error' && (
        <EmptyState
          className="session-list-empty"
          icon={<Icon name="history" />}
          title={t(view.rows.length ? 'session.archived.empty.noMatch' : 'session.archived.empty.fallback')}
          description={view.rows.length ? undefined : t('home.archived.emptyHelp')}
          actions={
            <Button size="small" onClick={() => archivedSessions.show('active')}>
              {t('home.archived.back')}
            </Button>
          }
        />
      )}
    </section>
  )
}

/** The sidebar list: active sessions by workspace, or the archived ones when that filter is on. */
export function SessionNavigation(props: { options: SidebarNavigationOptions; t: Translate }) {
  const view = useSyncExternalStore(archivedSessions.subscribe, archivedSessions.getSnapshot)
  return view.filter === 'archived' ? <ArchivedSessions {...props} /> : <WorkspaceSessions {...props} />
}

/**
 * The session list: one folder per workspace, newest session first inside it. A folder header
 * collapses its sessions and carries the "new session here" action; rows are an Ant Design X
 * Conversations list holding our own button and action menu, so focus, `aria-current` and menu
 * keyboard behaviour are unchanged contracts.
 */
function WorkspaceSessions({ options, t }: { options: SidebarNavigationOptions; t: Translate }) {
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
  const item = (row: SidebarNavigationOptions['sessions'][number]): ConversationItemType => {
    const title =
      row.title ||
      options.labels.get(row.sessionId) ||
      untitledSessionLabel(t('nav.sessionFallback'), row.createdAt, document.documentElement.lang || 'en')
    const active = row.sessionId === options.currentId
    const running = options.runningIds?.includes(row.sessionId) ?? false
    return {
      key: row.sessionId,
      className: 'session-row',
      'data-active': String(active),
      label: (
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
            <span className="session-title">{title}</span>
          </Button>
          {options.action && (
            <SessionMenu
              key={row.sessionId}
              id={row.sessionId}
              title={title}
              disabled={options.disabled ?? false}
              t={t}
              action={options.action}
              platform={options.runtimePlatform}
            />
          )}
        </>
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
          if (page?.groupId === 'unassigned' && page.total === 0) return null
          const workspace = options.workspaces.find((entry) =>
            page ? entry.workspaceId === page.workspaceId : entry.path === path,
          )
          const name = workspace ? workspaceLabel(workspace) : t('session.uncategorized')
          const collapsed = page ? !page.opened : collapsedGroups.has(path)
          const expanded = expandedGroups.has(path)
          const sorted = page ? sessions : sortSessionsByRecency(sessions)
          const { shown, hidden } = page
            ? { shown: sessions, hidden: Math.max(0, page.total - sessions.length) }
            : shownSessions(sorted, expanded, options.currentId)
          const toggleable = page
            ? !page.stale && page.loaded && (!!page.next || page.items.length > RECENT_SESSIONS)
            : sorted.length > RECENT_SESSIONS
          const listId = `workspace-sessions-${encodeURIComponent(path)}`
          return (
            <section key={path} className="workspace-group">
              <div className="workspace-heading-row">
                <Button
                  appearance="ghost"
                  className="workspace-heading"
                  aria-expanded={!collapsed}
                  aria-controls={listId}
                  title={workspace?.path ?? t('nav.noWorkspaceTitle')}
                  onClick={() => {
                    if (page) {
                      options.groupAction?.(path, 'toggle')
                      return
                    }
                    if (collapsed) collapsedGroups.delete(path)
                    else collapsedGroups.add(path)
                    saveCollapsedGroups()
                    redraw((value) => value + 1)
                  }}
                >
                  <FolderIcon className="icon icon-folder icon-folder-closed" />
                  <FolderIcon open className="icon icon-folder icon-folder-open" />
                  <span className="workspace-name">{name}</span>
                </Button>
                {workspace && (
                  <WorkspaceMenu
                    workspace={workspace}
                    name={name}
                    t={t}
                    platform={options.runtimePlatform}
                    disabled={options.disabled ?? false}
                    newDisabled={(options.newDisabled ?? false) || !workspace.available}
                    runningCount={
                      sessions.filter((row) => options.runningIds?.includes(row.sessionId)).length
                    }
                    newSession={() => options.newSession(workspace)}
                    action={options.workspaceAction}
                  />
                )}
              </div>
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
                    {page.loading && <p role="status">{t('nav.loading')}</p>}
                    {!page.ready && <p role="status">{t('nav.initializing')}</p>}
                    {(page.error || page.stale) && (
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
                    {page.loaded && page.items.length === 0 && !page.loading && <p>{t('nav.empty.title')}</p>}
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
                      if (expanded) expandedGroups.delete(path)
                      else expandedGroups.add(path)
                      saveExpandedGroups()
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

/** Compatibility mount for consumers outside the sidebar's React tree. */
export function renderSessionNavigation(
  options: SidebarNavigationOptions & { nav: HTMLElement },
  t: Translate,
): void {
  renderRegion(options.nav, <SessionNavigation options={options} t={t} />)
}
