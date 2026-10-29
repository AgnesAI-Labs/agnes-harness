import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, Icon, IconButton } from '@agnes/web-ui'
import {
  type SessionListMark,
  type SidebarNavigationOptions,
  untitledSessionLabel,
} from '@agnes/web-units/shell'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { navigationHistory } from './navigation-history.js'
import { SessionMenu } from './session-menu.js'
import { isLeadingKind, type Row, type SessionGroupView } from './sidebar-groups.js'
import { workspaceLabel } from './sidebar-label.js'
import {
  type DropPosition,
  SIDEBAR_SECTION_ORDER,
  type SidebarSectionId,
  workspaceKey,
} from './sidebar-order.js'

/** The workspace a row belongs to, and the name it goes by in a flat list or a search. */
export function workspaceNames(options: SidebarNavigationOptions, t: Translate) {
  const nameOf = (path: string | undefined): string => {
    const workspace = path ? options.workspaces.find((entry) => entry.path === path) : undefined
    if (workspace?.kind === 'chats') return t('nav.chats')
    if (workspace) return workspaceLabel(workspace)
    return path?.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  }
  return { nameOf }
}

const MARK_LABELS: Record<SessionListMark, string> = {
  approval: 'nav.waitingApproval',
  question: 'nav.waitingAnswer',
  completed: 'nav.completed',
  ended: 'nav.ended',
}

const DAY_MS = 86_400_000

/**
 * A row's last activity in the list's short form: 「刚刚」, 「5分钟」, 「3小时」, 「昨天」, 「4天」, then
 * the date. Days count calendar days, so a session from late last night already reads 「昨天」.
 */
export function relativeTime(iso: string | undefined, t: Translate, language: string, now = Date.now()) {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (!Number.isFinite(at)) return undefined
  const elapsed = Math.max(0, now - at)
  const midnight = (time: number) => {
    const date = new Date(time)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((midnight(now) - midnight(at)) / DAY_MS)
  if (days <= 0) {
    if (elapsed < 60_000) return t('nav.time.now')
    if (elapsed < 3_600_000) return t('nav.time.minutes', { count: Math.floor(elapsed / 60_000) })
    return t('nav.time.hours', { count: Math.floor(elapsed / 3_600_000) })
  }
  if (days === 1) return t('nav.time.yesterday')
  if (days < 7) return t('nav.time.days', { count: days })
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(language, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'numeric',
    day: 'numeric',
  }).format(at)
}

/**
 * One session row, shared by the paged list and the full-list views: an unread dot, the title, the
 * workspace name and pin mark the flat list adds, the archived treatment, and the action menu. The
 * row end says one thing, in this order: running, waiting for its owner, or when it last moved.
 */
export function SessionRowLabel({
  options,
  t,
  row,
  title,
  active,
  running,
  mark,
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
  /** Waiting for an approval or an answer, or a turn that ended while another session was on screen. */
  mark?: SessionListMark | undefined
  workspaceName?: string
  /** Offers 「Unpin」 in the menu; a grouped list shows that through its heading instead. */
  pinned: boolean
  /** The row-end pin mark, used only where no heading carries the pinned group. */
  pinnedMark: boolean
  archived: boolean
  restoring: boolean
  chats: boolean
}) {
  const waiting = !active && (mark === 'approval' || mark === 'question')
  const unread = !active && !running && (mark === 'completed' || mark === 'ended')
  const activity = row.lastMessageAt ?? row.createdAt
  const time =
    running || waiting ? undefined : relativeTime(activity, t, document.documentElement.lang || 'en')
  return (
    <>
      <Button
        appearance="ghost"
        className={active ? 'session active' : 'session'}
        disabled={options.disabled ?? false}
        data-session={row.sessionId}
        data-status={running ? 'running' : waiting ? 'waiting' : time ? 'time' : undefined}
        aria-current={active ? 'page' : undefined}
        title={title}
        onClick={() => options.open(row.sessionId)}
      >
        {unread && mark && (
          <span className="session-unread" data-mark={mark} role="img" aria-label={t(MARK_LABELS[mark])} />
        )}
        <span className="session-title">{title}</span>
        {workspaceName && <span className="session-workspace-label">{workspaceName}</span>}
        {running ? (
          <span className="session-running" role="img" aria-label={t('nav.running')} />
        ) : waiting && mark ? (
          <span className="session-mark" data-mark={mark} data-testid="session-mark">
            {t(MARK_LABELS[mark])}
          </span>
        ) : (
          time &&
          activity && (
            <time className="session-time" dateTime={activity}>
              {time}
            </time>
          )
        )}
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
export type HeadingDrag = {
  /** True while this row is the drag source; the row dims itself. */
  dragging?: boolean | undefined
  onDragStart(event: ReactDragEvent<HTMLElement>): void
  onDragEnd(): void
  onDragOver(event: ReactDragEvent<HTMLElement>): void
  onDragLeave(event: ReactDragEvent<HTMLElement>): void
  onDrop(event: ReactDragEvent<HTMLElement>): void
}

/**
 * One heading row for a section or a project: name, fold control, and the right-side actions.
 * Sections and projects share the row and title classes so they read as one family; a project
 * adds `is-nested`, its folder icon and its session count. The three section headings show no
 * icon, so a small chevron after the name carries their fold state instead. Only a project row
 * can be dragged or moved with Alt+Arrow; the sections keep their fixed order.
 */
export function SidebarSectionHeading({
  name,
  title,
  icon,
  count,
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
  /** A project's folder glyph; section headings have none and use the chevron instead. */
  icon?: ReactNode
  /** A project's session count, shown at the row end while the pointer is elsewhere. */
  count?: number | undefined
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
        title={title}
        // The name is the drag source: no separate handle sits in front of the heading.
        {...(drag
          ? {
              draggable: true,
              'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
              onDragStart: drag.onDragStart,
              onDragEnd: drag.onDragEnd,
            }
          : {})}
        onClick={onToggle}
        onKeyDown={onKeyDown}
      >
        {icon}
        <span className="workspace-name">{name}</span>
        {!icon && <Icon name="chevron-right" className="workspace-chevron" />}
        {count !== undefined && <span className="workspace-count">{count}</span>}
      </Button>
      {actions}
    </div>
  )
}

export const untitled = (options: SidebarNavigationOptions, t: Translate, row: Row, key: string) =>
  row.title ||
  options.labels.get(row.sessionId) ||
  untitledSessionLabel(t(key), row.createdAt, document.documentElement.lang || 'en')

/** One of the three peer sections: 置顶 / 项目 / 临时会话. */
export type SidebarSectionView = {
  id: SidebarSectionId
  title: string
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
 * The three sections in a fixed membership and a fixed order, 置顶 → 项目 → 临时会话: pinned and
 * chats hold one group each and are left out while empty; 项目 holds every project and always
 * shows, because its heading carries the list tools and the way to open a project folder.
 */
export function sectionViews(
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
  const byId: Record<SidebarSectionId, SidebarSectionView | undefined> = {
    pinned:
      pinned && hasRows(pinned)
        ? { id: 'pinned', title: t('nav.pinned'), group: pinned, groups: [] }
        : undefined,
    workspaces: { id: 'workspaces', title: t('sidebar.sectionHeading'), groups: projects },
    chats:
      chats && hasRows(chats) ? { id: 'chats', title: t('nav.chats'), group: chats, groups: [] } : undefined,
  }
  return SIDEBAR_SECTION_ORDER.flatMap((id) => byId[id] ?? [])
}
