import type { WorkspaceEntry } from '@agnes/protocol'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, IconButton, renderRegion, shortenHome } from '@agnes/web-ui'
import type { SidebarNavigationOptions } from '@agnes/web-units/shell'
import { useState, useSyncExternalStore } from 'react'
import { navigationHistory } from './navigation-history.js'
import { currentMode } from './session-inventory.js'
import { sidebarGrouping } from './sidebar-grouping.js'
import { FolderIcon, workspaceLabel } from './sidebar-label.js'
import { InventorySessions, WorkspaceSessions } from './sidebar-session-list.js'

// The list itself lives in `sidebar-session-list.tsx` and the label helpers in
// `sidebar-label.tsx`; these names stay here so existing importers keep working.
export { resetCollapsedGroups, resetExpandedGroups } from './sidebar-collapse.js'
export { NavigationLabel, workspaceLabel } from './sidebar-label.js'
export { RECENT_SESSIONS, shownSessions } from './sidebar-session-list.js'

const DAY_MS = 86_400_000

/** The picker's recent workspaces: one click selects; a folder that is gone can only be removed. */
export function WorkspaceOptions({
  workspaces,
  current,
  t,
  select,
  remove,
}: {
  workspaces: readonly WorkspaceEntry[]
  current?: string | undefined
  t: Translate
  select(workspace: WorkspaceEntry): void
  remove?(workspace: WorkspaceEntry): void
}) {
  // Removing archives the folder's sessions, so a folder that has any asks once, in place.
  const [confirming, setConfirming] = useState<string>()
  if (!workspaces.length) return <p className="workspace-option-none">{t('index-shell.noWorkspaceMatch')}</p>
  const relative = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', { numeric: 'auto' })
  const ask = (workspace: WorkspaceEntry) =>
    workspace.sessionCount > 0 ? setConfirming(workspace.path) : remove?.(workspace)
  return (
    <>
      {workspaces.map((workspace) => {
        const selected = workspace.path === current
        const used = workspace.lastUsedAt ? Date.parse(workspace.lastUsedAt) : Number.NaN
        return (
          <div
            key={workspace.path}
            className="workspace-option-row"
            data-available={String(workspace.available)}
            data-current={selected ? 'true' : undefined}
          >
            <Button
              className="workspace-option"
              data-available={String(workspace.available)}
              disabled={!workspace.available}
              aria-current={selected ? 'true' : undefined}
              title={workspace.path}
              onClick={() => select(workspace)}
            >
              <span className="workspace-option-icon">
                <FolderIcon />
              </span>
              <span className="workspace-option-copy">
                <span className="workspace-option-name">{workspaceLabel(workspace)}</span>
                {workspace.available ? (
                  <span className="workspace-option-path">{shortenHome(workspace.path)}</span>
                ) : (
                  <span className="workspace-option-reason">{t('index-shell.workspaceGone')}</span>
                )}
              </span>
              {selected ? (
                <span className="workspace-option-current">{t('index-shell.currentWorkspace')}</span>
              ) : (
                workspace.available &&
                Number.isFinite(used) && (
                  <span className="workspace-option-time">
                    {relative.format(Math.round((used - Date.now()) / DAY_MS), 'day')}
                  </span>
                )
              )}
            </Button>
            {remove &&
              !selected &&
              (workspace.available ? (
                <IconButton
                  className="workspace-option-remove"
                  name="x"
                  label={t('index-shell.removeWorkspace')}
                  onClick={() => ask(workspace)}
                />
              ) : (
                <Button className="workspace-option-drop" size="small" onClick={() => ask(workspace)}>
                  {t('index-shell.removeWorkspace')}
                </Button>
              ))}
            {confirming === workspace.path && (
              <div className="workspace-option-confirm">
                <p>{t('workspace.remove.description', { count: workspace.sessionCount })}</p>
                <Button size="small" onClick={() => setConfirming(undefined)}>
                  {t('workspace.remove.cancel')}
                </Button>
                <Button
                  size="small"
                  appearance="danger"
                  onClick={() => {
                    setConfirming(undefined)
                    remove?.(workspace)
                  }}
                >
                  {t('workspace.remove.confirm')}
                </Button>
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

export function renderWorkspaceOptions(
  container: HTMLElement,
  workspaces: readonly WorkspaceEntry[],
  select: (workspace: WorkspaceEntry) => void,
  t: Translate,
): void {
  renderRegion(container, <WorkspaceOptions workspaces={workspaces} t={t} select={select} />)
}

/**
 * The sidebar list. The default view keeps the host's paged projection: one group per workspace,
 * archived sessions hidden. Every other combination needs the whole list, so it renders the
 * inventory instead — flattened, mixing archived rows in, or showing only the archived ones.
 */
export function SessionNavigation(props: { options: SidebarNavigationOptions; t: Translate }) {
  const history = navigationHistory
  const view = useSyncExternalStore(history.subscribe, history.getSnapshot)
  const grouping = useSyncExternalStore(sidebarGrouping.subscribe, sidebarGrouping.getSnapshot)
  const mode = currentMode(view)
  // A host without `setMode` can only show the two-state filter, so the flat list is not offered.
  const flat = grouping === 'list' && typeof history.setMode === 'function'
  if (mode === 'active' && !flat) return <WorkspaceSessions {...props} />
  return <InventorySessions {...props} mode={mode} grouped={!flat} />
}

/** Compatibility mount for consumers outside the sidebar's React tree. */
export function renderSessionNavigation(
  options: SidebarNavigationOptions & { nav: HTMLElement },
  t: Translate,
): void {
  renderRegion(options.nav, <SessionNavigation options={options} t={t} />)
}
