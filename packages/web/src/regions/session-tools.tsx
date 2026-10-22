import type { Translate } from '@agnes/web-conversation/presentation'
import { Icon, IconButton, Menu, type MenuItem } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'
import { navigationHistory } from '../navigation-history.js'
import { currentMode, type SessionListMode, supportsModes } from '../session-inventory.js'
import { sidebarGrouping } from '../sidebar-grouping.js'

/** The sidebar asks for the search palette; the workbench owns it. */
export const SESSION_SEARCH_EVENT = 'agnes:session-search'

/** The session list heading names the current grouping; the filter speaks through the menu. */
export function SessionListLabel({ t }: { t: Translate }) {
  const grouping = useSyncExternalStore(sidebarGrouping.subscribe, sidebarGrouping.getSnapshot)
  return <>{t(grouping === 'list' ? 'sidebar.sectionHeadingList' : 'sidebar.sectionHeading')}</>
}

/** Search and the view menu: grouping and the archived filter both live in one menu. */
export function SessionListTools({ t }: { t: Translate }) {
  const history = navigationHistory
  const view = useSyncExternalStore(history.subscribe, history.getSnapshot)
  const grouping = useSyncExternalStore(sidebarGrouping.subscribe, sidebarGrouping.getSnapshot)
  const search = t('home.search.title')
  const mode = currentMode(view)
  const supported = supportsModes(history)
  const archived = mode === 'archived'
  const applyMode = (next: SessionListMode) => {
    if (supported) history.setMode?.(next)
    else history.show(next === 'archived' ? 'archived' : 'unarchived')
  }
  // Two groups under their own headings: how the list is arranged, then which sessions it holds.
  const groupingHeading = t('sidebar.view.grouping')
  const filterHeading = t('sidebar.view.filter')
  const choice = (
    id: string,
    group: string,
    label: string,
    icon: 'folder' | 'list' | 'eye' | 'message-square' | 'archive',
    checked: boolean,
    onSelect: () => void,
    available = true,
  ): MenuItem => ({
    id,
    group,
    testId: `session-view-${id}`,
    label,
    icon: <Icon name={icon} />,
    checked,
    ...(available ? {} : { disabled: true, disabledReason: t('sidebar.view.unsupported') }),
    onSelect,
  })
  const items: MenuItem[] = [
    choice(
      'group-workspace',
      groupingHeading,
      t('sidebar.view.byWorkspace'),
      'folder',
      !supported || grouping === 'workspace',
      () => sidebarGrouping.setGrouping('workspace'),
    ),
    choice(
      'group-list',
      groupingHeading,
      t('sidebar.view.singleList'),
      'list',
      grouping === 'list',
      () => sidebarGrouping.setGrouping('list'),
      supported,
    ),
    choice('filter-active', filterHeading, t('sidebar.view.hideArchived'), 'eye', mode === 'active', () =>
      applyMode('active'),
    ),
    choice(
      'filter-all',
      filterHeading,
      t('sidebar.view.allConversations'),
      'message-square',
      mode === 'all',
      () => applyMode('all'),
      supported,
    ),
    choice('filter-archived', filterHeading, t('sidebar.view.archivedOnly'), 'archive', archived, () =>
      applyMode('archived'),
    ),
  ]
  return (
    <span className="sidebar-session-tools">
      <IconButton
        id="session-search"
        name="search"
        label={search}
        shortcut={['mod', 'K']}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={(event) =>
          event.currentTarget.dispatchEvent(new CustomEvent(SESSION_SEARCH_EVENT, { bubbles: true }))
        }
      />
      <Menu
        label={t('sidebar.view.label')}
        selectedLabel={t('sidebar.view.selected')}
        trigger={
          <IconButton
            id="session-view"
            name="sliders-horizontal"
            label={t('sidebar.view.label')}
            aria-haspopup="menu"
          />
        }
        items={items}
      />
    </span>
  )
}
