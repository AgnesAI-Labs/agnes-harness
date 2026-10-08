import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PluginGenerationStatus,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import { settingsSections } from '@agnes/web-client'
import { Button, SettingsPage as SettingsPageLayout, SettingsState, useUiText } from '@agnes/web-ui'
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import type { SchedulesApi } from './schedules.js'
import './registry.js'
export const SETTINGS_PAGES = settingsSections
  .entries()
  .filter((entry) => !entry.nativePane)
  .map((entry) => entry.id)
export type SettingsPage = string
function initialPage(): SettingsPage {
  const value = new URLSearchParams(location.search).get('settings')
  const embedded = document.querySelector<HTMLElement>('#config-form')?.dataset.runtimePage
  return settingsSections.get(embedded ?? value ?? '')?.id ?? 'plugins'
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
  const [snapshot, setSnapshot] = useState<RuntimeAdminSnapshot>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: registryVersion invalidates a disposed selection.
  useEffect(() => {
    if (!settingsSections.get(page)) setPage('plugins')
  }, [page, registryVersion])
  useEffect(() => {
    const listener = (event: Event) => {
      const value = (event as CustomEvent<SettingsPage>).detail
      if (settingsSections.get(value)) setPage(value)
    }
    document.addEventListener('agnes:settings-page', listener)
    return () => document.removeEventListener('agnes:settings-page', listener)
  }, [])
  useEffect(() => {
    onPage(page)
  }, [page, onPage])
  const sectionTitle = (id: string) => {
    const key = settingsSections.get(id)?.titleKey ?? id
    const value = hostT(key)
    return value === key ? t(id) : value
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit refresh.
  useEffect(() => {
    let current = true
    setSnapshot(undefined)
    setFailed(false)
    if (!api) return
    setBusy(true)
    void api
      .runtime()
      .then((value) => {
        if (current) setSnapshot(value)
      })
      .catch(() => {
        if (current) setFailed(true)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
  }, [api, revision])
  return (
    <div className="runtime-settings">
      {!embedded && (
        <nav aria-label={t('navigation')} data-testid="settings-navigation">
          {settingsSections
            .entries()
            .filter((entry) => !entry.nativePane)
            .map(({ id }) => (
              <Button
                key={id}
                data-testid={`settings-nav-${id}`}
                aria-current={page === id ? 'page' : undefined}
                type={page === id ? 'primary' : 'default'}
                onClick={() => setPage(id)}
              >
                {sectionTitle(id)}
              </Button>
            ))}
        </nav>
      )}
      <section data-testid={`settings-page-${page}`} aria-label={sectionTitle(page)}>
        <SettingsPageLayout
          title={sectionTitle(page)}
          actions={
            page !== 'diagnostics' && (
              <Button
                data-testid="settings-refresh"
                disabled={!api || busy}
                aria-busy={busy}
                onClick={() => setRevision((value) => value + 1)}
              >
                {t('retry')}
              </Button>
            )
          }
        >
          {busy && <SettingsState tone="loading">{t('loading')}</SettingsState>}
          {failed && <SettingsState tone="error">{t('unavailable')}</SettingsState>}
          {(() => {
            const Component = settingsSections.get(page)?.component
            return Component ? (
              <Component
                key={`${page}:${revision}`}
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
                    onRefresh,
                    onReview,
                    schedules,
                    snapshot,
                    navigate: setPage,
                  },
                }}
              />
            ) : (
              <SettingsState>{t('unavailable')}</SettingsState>
            )
          })()}
        </SettingsPageLayout>
      </section>
    </div>
  )
}
