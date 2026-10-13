import type { Translate } from '@agnes/web-conversation/presentation'
import { Icon, IconButton, Menu } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'
import { archivedSessions } from '../archived-sessions.js'

/** The sidebar asks for the search palette; the workbench owns it. */
export const SESSION_SEARCH_EVENT = 'agnes:session-search'

const searchShortcut = () => (/Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘K' : 'Ctrl+K')

/** The session list heading: workspaces, or the filter that replaced them. */
export function SessionListLabel({ t }: { t: Translate }) {
  const view = useSyncExternalStore(archivedSessions.subscribe, archivedSessions.getSnapshot)
  return <>{t(view.filter === 'archived' ? 'home.filter.archived' : 'sidebar.sectionHeading')}</>
}

/** Search sessions and choose which sessions the list shows. */
export function SessionListTools({ t }: { t: Translate }) {
  const view = useSyncExternalStore(archivedSessions.subscribe, archivedSessions.getSnapshot)
  const search = t('home.search.open', { shortcut: searchShortcut() })
  const filter = view.filter === 'archived' ? t('home.filter.showingArchived') : t('home.filter.label')
  return (
    <>
      <IconButton
        id="session-search"
        name="search"
        label={search}
        aria-keyshortcuts="Meta+K Control+K"
        onClick={(event) =>
          event.currentTarget.dispatchEvent(new CustomEvent(SESSION_SEARCH_EVENT, { bubbles: true }))
        }
      />
      <Menu
        label={filter}
        trigger={
          <IconButton
            id="session-filter"
            name="sliders-horizontal"
            label={filter}
            data-filter={view.filter}
            {...(view.filter === 'archived' ? { className: 'session-filter-on' } : {})}
          />
        }
        items={(['active', 'archived'] as const).map((id) => ({
          id,
          testId: `session-filter-${id}`,
          label: t(`home.filter.${id}`),
          icon: view.filter === id ? <Icon name="check" /> : <span className="session-filter-unset" />,
          onSelect: () => archivedSessions.show(id),
        }))}
      />
    </>
  )
}
