import { type HomeEntry, type HomeEntryBadge, homeEntries, homeNavigation } from '@agnes/web-client'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, Icon, type IconName, icons, Menu, Tooltip } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'
import { BUILTIN_HOME_ENTRIES } from '../pages/entries.js'

/** Plugin entries shown in the sidebar before the rest collapse under "More". */
const INLINE_PLUGIN_ENTRIES = 3

function EntryBadge({ badge, label }: { badge: HomeEntryBadge; label(count: number): string }) {
  const count = useSyncExternalStore(badge.subscribe, badge.getSnapshot)
  if (!(count > 0)) return null
  return (
    <span className="home-entry-badge" title={label(count)}>
      <span aria-hidden="true">{count > 99 ? '99+' : count}</span>
      <span className="visually-hidden">{label(count)}</span>
    </span>
  )
}

const entryIcon = (entry: HomeEntry): IconName =>
  Object.hasOwn(icons, entry.icon) ? (entry.icon as IconName) : 'puzzle'

const entryLabel = (entry: HomeEntry, t: Translate): string =>
  entry.subtitleKey ? `${t(entry.titleKey)} · ${t(entry.subtitleKey)}` : t(entry.titleKey)

/** The home entries above the session list: the three built-in pages, then the ones plugins add. */
export function HomeEntriesNav({ t, onSelect }: { t: Translate; onSelect?(): void }) {
  useSyncExternalStore(homeEntries.subscribe, homeEntries.getSnapshot)
  const requested = useSyncExternalStore(homeNavigation.subscribe, homeNavigation.getSnapshot)
  const entries = homeEntries.entries()
  const builtin = BUILTIN_HOME_ENTRIES.flatMap((id) => entries.find((entry) => entry.id === id) ?? [])
  const added = entries.filter((entry) => !BUILTIN_HOME_ENTRIES.includes(entry.id))
  const inline = added.length > INLINE_PLUGIN_ENTRIES ? [] : added
  const more = added.length > INLINE_PLUGIN_ENTRIES ? added : []
  const open = (entry: HomeEntry) => {
    homeNavigation.open(entry.id)
    onSelect?.()
  }
  if (!entries.length) return null
  return (
    <nav className="home-entries" aria-label={t('home.entries.nav')} data-testid="home-entries">
      {[...builtin, ...inline].map((entry) => (
        <Tooltip key={entry.id} title={entryLabel(entry, t)}>
          <Button
            appearance="ghost"
            className="home-entry"
            data-testid={`home-entry-${entry.id}`}
            aria-label={entryLabel(entry, t)}
            aria-current={requested?.id === entry.id ? 'page' : undefined}
            onClick={() => open(entry)}
          >
            <Icon name={entryIcon(entry)} />
            <span className="home-entry-label">
              {t(entry.titleKey)}
              {entry.subtitleKey && <span className="home-entry-sub">{t(entry.subtitleKey)}</span>}
            </span>
            {entry.badge && (
              <EntryBadge
                badge={entry.badge}
                label={(count) =>
                  entry.id === 'plugins' ? t('home.entry.plugins.pending', { count }) : String(count)
                }
              />
            )}
          </Button>
        </Tooltip>
      ))}
      {more.length > 0 && (
        <Tooltip title={t('home.entry.more')}>
          <Menu
            label={t('home.entry.more')}
            trigger={
              <Button
                appearance="ghost"
                className="home-entry"
                data-testid="home-entry-more"
                aria-label={t('home.entry.more')}
                aria-current={more.some((entry) => entry.id === requested?.id) ? 'page' : undefined}
              >
                <Icon name="ellipsis" />
                <span className="home-entry-label">{t('home.entry.more')}</span>
              </Button>
            }
            items={more.map((entry) => ({
              id: entry.id,
              label: t(entry.titleKey),
              onSelect: () => open(entry),
            }))}
          />
        </Tooltip>
      )}
    </nav>
  )
}
