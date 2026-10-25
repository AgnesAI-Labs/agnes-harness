import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, Icon, IconButton } from '@agnes/web-ui'
import { type SidebarNavigationOptions, untitledSessionLabel } from '@agnes/web-units/shell'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { navigationHistory } from './navigation-history.js'
import { SessionMenu } from './session-menu.js'
import { isLeadingKind, type Row, type SessionGroupView } from './sidebar-groups.js'
import { FolderIcon, NavigationLabel, workspaceLabel } from './sidebar-label.js'
import { type DropPosition, type SidebarSectionId, workspaceKey } from './sidebar-order.js'

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

/**
 * One session row, shared by the paged list and the full-list views: title, running dot, the
 * workspace name and pin mark the flat list adds, the archived treatment, and the action menu.
 */
export function SessionRowLabel({
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
 * One heading row for a section or a project: drag handle, icon, name, fold, and the right-side
 * actions. Sections and projects share the row and title classes so they read as one family;
 * a project adds `is-nested` for its extra indent.
 */
export function SidebarSectionHeading({
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

export const untitled = (options: SidebarNavigationOptions, t: Translate, row: Row, key: string) =>
  row.title ||
  options.labels.get(row.sessionId) ||
  untitledSessionLabel(t(key), row.createdAt, document.documentElement.lang || 'en')

/** One of the three peer sections: 置顶 / 临时会话 / 工作区. */
export type SidebarSectionView = {
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
