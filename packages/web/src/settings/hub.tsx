import type {
  PackageCatalogDescriptor,
  PackageInstalledDescriptor,
  PluginGenerationStatus,
  RuntimeAdminSnapshot,
} from '@agnes/protocol'
import { Button, useUiText } from '@agnes/web-ui'
import { type ReactNode, useEffect, useState } from 'react'
import type { PluginAdminApi } from '../admin/plugins/api.js'
import { BundlesPanel, SessionDefaultsPanel } from '../admin/plugins/control-panel.js'
import { ExamplesPanel } from './examples.js'
import { HistorySearchPanel } from './history.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import {
  GenerationsPanel,
  LocalPluginsPanel,
  PresetsPanel,
  ProvidersPanel,
  PublicationPanel,
  SecurityPanel,
  sessionStartUrl,
} from './runtime-panels.js'
import { SearchPanel } from './search.js'

export const SETTINGS_PAGES = [
  'plugins',
  'providers',
  'search',
  'models',
  'bundles',
  'security',
  'resources',
  'examples',
  'history',
] as const
export type SettingsPage = (typeof SETTINGS_PAGES)[number]
function initialPage(): SettingsPage {
  const value = new URLSearchParams(location.search).get('settings')
  return SETTINGS_PAGES.find((page) => page === value) ?? 'plugins'
}
export function SettingsHub({
  api,
  canSave,
  pluginText,
  installed,
  generations,
  children,
  onPage,
  onRefresh,
  onReview,
}: {
  api: PluginAdminApi | undefined
  canSave: boolean
  pluginText(key: string): string
  installed: readonly PackageInstalledDescriptor[]
  generations: PluginGenerationStatus | undefined
  children?: ReactNode
  onPage(page: SettingsPage): void
  onRefresh(): Promise<void>
  onReview(item: PackageCatalogDescriptor): void
}) {
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [snapshot, setSnapshot] = useState<RuntimeAdminSnapshot>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    onPage(page)
  }, [page, onPage])
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
      <nav aria-label={t('navigation')} data-testid="settings-navigation">
        {SETTINGS_PAGES.map((id) => (
          <Button
            key={id}
            data-testid={`settings-nav-${id}`}
            aria-current={page === id ? 'page' : undefined}
            type={page === id ? 'primary' : 'default'}
            onClick={() => setPage(id)}
          >
            {t(id)}
          </Button>
        ))}
      </nav>
      <section data-testid={`settings-page-${page}`} aria-label={t(page)}>
        <h2>{t(page)}</h2>
        {busy && <p role="status">{t('loading')}</p>}
        {failed && <p role="alert">{t('unavailable')}</p>}
        <Button
          data-testid="settings-refresh"
          disabled={!api || busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t('retry')}
        </Button>
        {page === 'plugins' && (
          <>
            <GenerationsPanel status={generations} api={api} canSave={canSave} t={t} onRefresh={onRefresh} />
            {snapshot && <PublicationPanel snapshot={snapshot} t={t} />}
            {api && snapshot && (
              <LocalPluginsPanel
                api={api}
                snapshot={snapshot}
                canSave={canSave}
                t={t}
                onRefresh={onRefresh}
              />
            )}
            <p>{t('creatorHelp')}</p>
            <Button data-testid="plugin-creator" href={sessionStartUrl(undefined, t('creatorPrompt'))}>
              {t('creator')}
            </Button>
            {children}
          </>
        )}
        {page === 'providers' && snapshot && <ProvidersPanel snapshot={snapshot} t={t} />}
        {page === 'search' && <SearchPanel t={t} canSave={canSave} />}
        {page === 'models' && (
          <>
            <p>{t('modelsHelp')}</p>
            <SessionDefaultsPanel api={api} canSave={canSave} t={pluginText} />
            <Button href="/?settings=model">{t('accounts')}</Button>
          </>
        )}
        {page === 'bundles' && (
          <>
            <BundlesPanel api={api} canSave={canSave} t={pluginText} presets={snapshot?.presets ?? []} />
            {snapshot && <PresetsPanel snapshot={snapshot} t={t} />}
          </>
        )}
        {page === 'security' && snapshot && <SecurityPanel snapshot={snapshot} t={t} />}
        {page === 'resources' && (
          <>
            <p>{t('resourcesHelp')}</p>
            <Button href="/admin/resources">{t('openResources')}</Button>
            <iframe className="runtime-resources" title={t('resources')} src="/admin/resources" />
          </>
        )}
        {page === 'examples' && (
          <ExamplesPanel
            api={api}
            installed={installed}
            t={t}
            onReview={onReview}
            onBundles={() => setPage('bundles')}
          />
        )}
        {page === 'history' && <HistorySearchPanel t={t} />}
      </section>
    </div>
  )
}
