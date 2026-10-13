import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, EmptyState, Icon, renderRegion } from '@agnes/web-ui'
import { type ConversationItemType, Conversations, XProvider } from '@agnes/web-ui/x'
import { groupSessionsByTime, type SidebarNavigationOptions } from '@agnes/web-units'
import { SessionMenu } from './session-menu.js'

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

/**
 * The session list: Ant Design X Conversations grouped by the local day a session was created.
 * Rows keep our own button and action menu, so focus, `aria-current` and menu keyboard behaviour
 * are the same contracts as before; Conversations owns grouping and the list surface.
 */
export function SessionNavigation({ options, t }: { options: SidebarNavigationOptions; t: Translate }) {
  const menuEpoch = JSON.stringify([
    options.sessions,
    options.workspaces,
    [...options.labels],
    options.currentId,
    options.disabled,
    options.newDisabled,
    options.next,
    t('session.menu.label'),
  ])
  const sessions = options.sessions.filter((row) => !row.archived)
  // With one workspace its name on every row is noise; with several it tells the rows apart.
  const workspaceNames = new Map(
    options.workspaces.length > 1
      ? options.workspaces.map((workspace) => [workspace.path, workspaceLabel(workspace)])
      : [],
  )
  const items: ConversationItemType[] = groupSessionsByTime(sessions, new Date()).flatMap(({ group, rows }) =>
    rows.map((row) => {
      const title =
        row.title ||
        options.labels.get(row.sessionId) ||
        t('nav.sessionFallback', { id: row.sessionId.slice(-8) })
      const active = row.sessionId === options.currentId
      const running = options.runningIds?.includes(row.sessionId) ?? false
      const workspace = row.cwd ? workspaceNames.get(row.cwd) : undefined
      return {
        key: row.sessionId,
        group: t(`nav.group.${group}`),
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
              {workspace && <span className="session-workspace">{workspace}</span>}
            </Button>
            {options.action && (
              <SessionMenu
                key={menuEpoch}
                id={row.sessionId}
                title={title}
                disabled={options.disabled ?? false}
                t={t}
                action={options.action}
              />
            )}
          </>
        ),
      }
    }),
  )
  return (
    <>
      {items.length === 0 ? (
        <EmptyState
          className="session-list-empty"
          icon={<Icon name="message-square" />}
          title={t('nav.empty.title')}
          description={t('nav.empty.description')}
        />
      ) : (
        <XProvider>
          <Conversations
            className="session-conversations"
            classNames={{ group: 'session-group' }}
            {...(options.currentId ? { activeKey: options.currentId } : {})}
            items={items}
            groupable={{ label: (group) => <span className="session-group-label">{group}</span> }}
          />
        </XProvider>
      )}
      {options.next && options.loadMore && (
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
