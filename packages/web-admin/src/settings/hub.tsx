import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PluginGenerationStatus,
} from '@agnes/protocol'
import { type SettingsSection, settingsSections } from '@agnes/web-client'
import {
  Banner,
  Button,
  Disclosure,
  Icon,
  type IconName,
  PushCrumbs,
  SettingsInput,
  SettingsPage as SettingsPageLayout,
  SettingsState,
  scopedResourceKey,
  useResource,
  useUiText,
} from '@agnes/web-ui'
import {
  advancedSettings,
  matchesSettings,
  revealSettingsAnchor,
  settingsGroup,
  settingsRoute,
} from '@agnes/web-units/shell'
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import { PLUGIN_ADMIN_PAGES } from './registry.js'
import type { SchedulesApi } from './schedules.js'
export type SettingsPage = string
const groupIcons: Readonly<Record<string, IconName>> = {
  plugins: 'puzzle',
  advanced: 'sliders-horizontal',
  tools: 'sliders-horizontal',
  automation: 'clock',
  security: 'shield-check',
  history: 'history',
  diagnostics: 'activity',
  skills: 'sparkles',
}
/** Every page this hub can show: its own two, then the registered sections without a native pane. */
const hubEntries = (): SettingsSection[] => [
  ...PLUGIN_ADMIN_PAGES,
  ...settingsSections.entries().filter((entry) => !entry.nativePane),
]
/** The plugin pages are one group of their own; everything else groups as the settings dialog does. */
const hubGroup = (group: string): string => (group === 'plugins' ? group : settingsGroup(group))
function hubNavigationGroups(entries: readonly SettingsSection[]): SettingsSection[][] {
  const groups = new Map<string, SettingsSection[]>()
  for (const entry of [...entries].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)))
    groups.set(hubGroup(entry.group), [...(groups.get(hubGroup(entry.group)) ?? []), entry])
  return [...groups.values()]
}
export const SETTINGS_PAGES = hubEntries().map((entry) => entry.id)
function hubSection(id: string) {
  const entry = hubEntries().find((candidate) => candidate.id === id)
  // Inside the workbench the dialog's own pages have their own host; this hub keeps to plugins.
  return entry && document.getElementById('config-form') && entry.group !== 'plugins' ? undefined : entry
}
function initialPage(): SettingsPage {
  const value = new URLSearchParams(location.search).get('settings')
  const embedded = document.querySelector<HTMLElement>('#config-form')?.dataset.runtimePage
  const route = settingsRoute(embedded ?? value ?? '')
  if (!document.getElementById('config-form') && value && hubSection(route.id)) {
    if (route.terminal) location.assign('/?settings=terminal')
    else {
      const url = new URL(location.href)
      url.searchParams.set('settings', route.id)
      if (route.anchor) url.hash = route.anchor
      history.replaceState(history.state, '', url)
    }
  }
  return hubSection(route.id)?.id ?? 'plugins'
}
export function SettingsHub({
  api,
  canSave,
  canInstall = false,
  pluginText,
  installed,
  generations,
  children,
  onPage,
  onRefresh,
  onReview,
  schedules,
}: {
  api: PluginAdminApi | undefined
  canSave: boolean
  canInstall?: boolean
  pluginText(key: string): string
  installed: readonly PackageInstalledDescriptor[]
  generations: PluginGenerationStatus | undefined
  children?: ReactNode
  onPage(page: SettingsPage): void
  onRefresh(): Promise<void>
  onReview(item: PackageCatalogDescriptor): void
  schedules?: SchedulesApi
}) {
  const registryVersion = useSyncExternalStore(settingsSections.subscribe, settingsSections.getSnapshot)
  const { t, hostT } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const embedded = !!document.getElementById('config-form')
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState(() => !!new URLSearchParams(location.search).get('settings'))
  const needsRuntimeCatalog = hubSection(page)?.runtimeCatalog !== false
  const resource = useResource(
    api && needsRuntimeCatalog ? scopedResourceKey(api, `settings:hub:${page}`) : undefined,
    () => {
      if (!api) throw new Error('Admin unavailable')
      return api.runtime()
    },
  )
  const snapshot = resource.data
  const busy = resource.loading
  const failed = !!resource.error
  // biome-ignore lint/correctness/useExhaustiveDependencies: registryVersion invalidates a disposed selection.
  useEffect(() => {
    if (!hubSection(page)) setPage('plugins')
  }, [page, registryVersion])
  useEffect(() => {
    const listener = (event: Event) => {
      const value = (event as CustomEvent<SettingsPage>).detail
      const route = settingsRoute(value)
      if (hubSection(route.id)) setPage(route.id)
    }
    document.addEventListener('agnes:settings-page', listener)
    return () => document.removeEventListener('agnes:settings-page', listener)
  }, [])
  useEffect(() => {
    let current = true
    // The native settings controller commits its navigation synchronously. Notify it after
    // this React lifecycle so its flushSync does not run inside the current commit.
    queueMicrotask(() => {
      if (!current) return
      onPage(page)
      const hash = location.hash.slice(1)
      if (hash.startsWith('settings-subsection-')) requestAnimationFrame(() => revealSettingsAnchor(hash))
    })
    return () => {
      current = false
    }
  }, [page, onPage])
  useEffect(() => {
    if (embedded) return
    const listener = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target as Element)?.closest('input, textarea, select, [contenteditable=true]')
      )
        return
      event.preventDefault()
      if (window.matchMedia('(max-width: 767px)').matches) setDetail(false)
      requestAnimationFrame(() => document.getElementById('settings-search')?.focus())
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [embedded])
  const shellText = (key: string) => {
    const value = hostT(key)
    return value === key ? t(key) : value
  }
  const sectionTitle = (id: string) => {
    const key = hubSection(id)?.titleKey ?? id
    const value = shellText(key)
    return value === key ? t(id) : value
  }
  const navigate = (id: string) => {
    if (embedded) {
      document
        .getElementById('config-form')
        ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: id, bubbles: true }))
      return
    }
    const route = settingsRoute(id)
    if (!hubSection(route.id)) return
    const tabFocused = document.activeElement?.getAttribute('role') === 'tab'
    setPage(route.id)
    setDetail(true)
    const url = new URL(location.href)
    url.searchParams.set('settings', route.id)
    url.hash = route.anchor ?? ''
    history.replaceState(history.state, '', url)
    if (route.anchor) requestAnimationFrame(() => revealSettingsAnchor(route.anchor ?? ''))
    if (!tabFocused && window.matchMedia('(max-width: 767px)').matches)
      requestAnimationFrame(() =>
        document.querySelector<HTMLButtonElement>('[data-testid="settings-back"]')?.focus(),
      )
  }
  const groups = hubNavigationGroups(hubEntries())
  const groupEntries = hubEntries().filter(
    (entry) => !entry.nativePane && hubGroup(entry.group) === hubGroup(hubSection(page)?.group ?? ''),
  )
  const renderGroup = (group: (typeof groups)[number]) => {
    const first = group[0]
    if (!first) return null
    const match = group.find((entry) =>
      matchesSettings(
        query,
        [
          sectionTitle(entry.id),
          shellText(entry.groupTitleKey),
          shellText(`settings-shell.keywords.${hubGroup(entry.group)}`),
        ].join(' '),
      ),
    )
    if (!match) return null
    if (hubGroup(first.group) === 'extensions')
      return group
        .filter((entry) => matchesSettings(query, sectionTitle(entry.id) + shellText(entry.groupTitleKey)))
        .map((entry) => (
          <Button
            key={entry.id}
            appearance="ghost"
            className="settings-nav-item"
            data-testid={`settings-nav-${entry.id}`}
            aria-current={entry.id === page ? 'page' : undefined}
            onClick={() => navigate(entry.id)}
          >
            <Icon name="puzzle" size={20} />
            {sectionTitle(entry.id)}
            <small>{shellText(entry.groupTitleKey)}</small>
          </Button>
        ))
    return (
      <Button
        key={first.id}
        appearance="ghost"
        className="settings-nav-item"
        data-testid={`settings-nav-${first.id}`}
        aria-current={group.some((entry) => entry.id === page) ? 'page' : undefined}
        onClick={() => navigate(query ? match.id : first.id)}
      >
        <Icon name={groupIcons[first.group] ?? 'settings'} size={20} />
        {shellText(first.groupTitleKey)}
      </Button>
    )
  }
  return (
    <div className="runtime-settings" data-settings-view={detail ? 'detail' : 'list'}>
      {!embedded && (
        <nav
          aria-label={shellText('settings-shell.railAria')}
          data-testid="settings-navigation"
          className="settings-rail"
        >
          <h2>{shellText('settings-shell.railTitle')}</h2>
          <label className="agnes-ui-field" htmlFor="settings-search">
            <span className="visually-hidden">{shellText('settings-shell.findSettings')}</span>
            <SettingsInput
              id="settings-search"
              data-testid="settings-search"
              type="search"
              value={query}
              placeholder={shellText('settings-shell.findSettings')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('')
              }}
            />
          </label>
          <p className="settings-nav-label">{shellText('settings-shell.basicLabel')}</p>
          {groups.filter((group) => !advancedSettings(group[0]?.group ?? '')).map(renderGroup)}
          <Disclosure
            variant="plain"
            data-testid="settings-advanced"
            open={query ? true : undefined}
            summary={shellText('settings-shell.advanced')}
          >
            {groups.filter((group) => advancedSettings(group[0]?.group ?? '')).map(renderGroup)}
          </Disclosure>
          {!groups.some((group) =>
            group.some((entry) =>
              matchesSettings(
                query,
                sectionTitle(entry.id) + shellText(`settings-shell.keywords.${hubGroup(entry.group)}`),
              ),
            ),
          ) && <SettingsState>{shellText('settings-shell.noSettings')}</SettingsState>}
        </nav>
      )}
      <section data-testid={`settings-page-${page}`} aria-label={sectionTitle(page)}>
        {!embedded && (
          <>
            {/* A narrow screen shows one page; the breadcrumb leads back to the list (「‹ Settings › Current page」). */}
            <PushCrumbs
              title={sectionTitle(page)}
              crumbs={[shellText('settings-shell.root')]}
              backTestId="settings-back"
              onBack={() => {
                setDetail(false)
                requestAnimationFrame(() =>
                  document.querySelector<HTMLButtonElement>('.settings-rail [aria-current="page"]')?.focus(),
                )
              }}
            />
            {groupEntries.length > 1 && (
              <h2 className="agnes-settings-group-title">
                {shellText(groupEntries[0]?.groupTitleKey ?? '')}
              </h2>
            )}
            {groupEntries.length > 1 && (
              <div
                className="agnes-settings-section-tabs"
                role="tablist"
                aria-label={shellText(hubSection(page)?.groupTitleKey ?? '')}
              >
                {groupEntries.map((entry) => (
                  <Button
                    key={entry.id}
                    appearance="ghost"
                    role="tab"
                    id={`settings-section-tab-${entry.id}`}
                    data-testid={`settings-nav-${entry.id}-tab`}
                    aria-selected={entry.id === page}
                    aria-controls={`settings-hub-panel-${entry.id}`}
                    tabIndex={entry.id === page ? 0 : -1}
                    onClick={() => navigate(entry.id)}
                    onKeyDown={(event) => {
                      const index = groupEntries.indexOf(entry)
                      const next =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? groupEntries.length - 1
                            : event.key === 'ArrowRight'
                              ? (index + 1) % groupEntries.length
                              : event.key === 'ArrowLeft'
                                ? (index - 1 + groupEntries.length) % groupEntries.length
                                : -1
                      if (next < 0) return
                      event.preventDefault()
                      const target = groupEntries[next]
                      if (target) {
                        navigate(target.id)
                        requestAnimationFrame(() =>
                          document.getElementById(`settings-section-tab-${target.id}`)?.focus(),
                        )
                      }
                    }}
                  >
                    {sectionTitle(entry.id)}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
        <div
          id={`settings-hub-panel-${page}`}
          {...(!embedded && groupEntries.length > 1
            ? { role: 'tabpanel', 'aria-labelledby': `settings-section-tab-${page}` }
            : {})}
        >
          <SettingsPageLayout
            title={sectionTitle(page)}
            variant={['plugins', 'discover', 'history'].includes(page) ? 'list' : 'form'}
          >
            {needsRuntimeCatalog && busy && (
              <SettingsState tone="loading" data-testid="settings-catalog-state">
                {t('loading')}
              </SettingsState>
            )}
            {needsRuntimeCatalog && failed && (
              <Banner tone="error" data-testid="settings-catalog-state">
                {t('readFailed')} ·{' '}
                <Button type="text" size="small" onClick={resource.reload}>
                  {t('retry')}
                </Button>
              </Banner>
            )}
            {(() => {
              const Component = hubSection(page)?.component
              return Component ? (
                <Component
                  key={page}
                  context={{
                    t: (key, vars) => {
                      const value = t(key, vars)
                      return value === key ? hostT(key, vars) : value
                    },
                    data: {
                      api,
                      canSave,
                      canInstall,
                      pluginText,
                      installed,
                      generations,
                      children,
                      onRefresh: async () => {
                        resource.reload()
                        await onRefresh()
                      },
                      onReview,
                      schedules,
                      snapshot,
                      navigate,
                    },
                  }}
                />
              ) : (
                <SettingsState>{t('unavailable')}</SettingsState>
              )
            })()}
          </SettingsPageLayout>
        </div>
      </section>
    </div>
  )
}
