import {
  applicationIdentity,
  effectiveApplication,
  type HomeEntry,
  type HomeEntryBadge,
  homeEntries,
  homeEntryGroups,
  homeNavigation,
  resolveHomeEntry,
} from '@agnes/web-client'
import type { Translate } from '@agnes/web-conversation/presentation'
import { Button, Icon, type IconName, icons, Menu, Tooltip } from '@agnes/web-ui'
import { type ReactNode, useSyncExternalStore } from 'react'
import { useWorkLaunchQuiet } from '../pages/work-launch.js'

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
  Object.hasOwn(icons, entry.icon) ? (entry.icon as IconName) : 'file'

const entryLabel = (entry: HomeEntry, t: Translate): string =>
  entry.subtitleKey ? `${t(entry.titleKey)} · ${t(entry.subtitleKey)}` : t(entry.titleKey)

/** The home entries above the session list: the three built-in pages, then the ones plugins add. */
export function HomeEntriesNav({
  t,
  onSelect,
  children,
}: {
  t: Translate
  onSelect?(): void
  children?: ReactNode
}) {
  useSyncExternalStore(homeEntries.subscribe, homeEntries.getSnapshot)
  const requested = useSyncExternalStore(homeNavigation.subscribe, homeNavigation.getSnapshot)
  const quiet = useWorkLaunchQuiet()
  useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const application = applicationIdentity.getSnapshot()
  const nav = effectiveApplication()?.presentation?.navigation
  const activePackage = effectiveApplication() ? application?.selection?.packageId : undefined
  let entries = homeEntries.entries().filter((entry) => {
    if (nav?.hideBuiltin?.some((id) => id === entry.id)) return false
    const owner = application?.candidates.find(
      (candidate) => resolveHomeEntry(`${candidate.packageId}#${entry.id}`) === entry,
    )
    return !owner || owner.packageId === activePackage
  })
  const references = new Map(
    (nav?.entries ?? []).flatMap((ref) => {
      const entry = resolveHomeEntry(ref)
      return entry ? [[entry.id, ref] as const] : []
    }),
  )
  const order = [...references.keys()]
  entries = entries
    .sort((a, b) => {
      const x = order.indexOf(a.id),
        y = order.indexOf(b.id)
      return (x < 0 ? 1000 : x) - (y < 0 ? 1000 : y)
    })
    .map((entry, order) => ({ ...entry, order }))
  const { inline, more } = homeEntryGroups(entries)
  const isCurrent = (entry: HomeEntry) =>
    !quiet &&
    requested?.id === entry.id &&
    (!requested.pageRef || resolveHomeEntry(requested.pageRef) === homeEntries.get(entry.id))
  const open = (entry: HomeEntry) => {
    const ref = references.get(entry.id)
    if (ref) homeNavigation.openRef(ref)
    else homeNavigation.open(entry.id)
    onSelect?.()
  }
  if (!entries.length && !children) return null
  return (
    <nav className="home-entries" aria-label={t('home.entries.nav')} data-testid="home-entries">
      {inline.map((entry) => (
        <Tooltip key={entry.id} title={entryLabel(entry, t)}>
          <Button
            appearance="ghost"
            className="home-entry"
            data-testid={`home-entry-${entry.id}`}
            aria-label={entryLabel(entry, t)}
            aria-current={isCurrent(entry) ? 'page' : undefined}
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
                aria-current={more.some(isCurrent) ? 'page' : undefined}
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
      {children}
    </nav>
  )
}
