import type { PluginGenerationStatus, RuntimeAdminSnapshot } from '@agnes/protocol'
import { settingsSections } from '@agnes/web-client'
import {
  Banner,
  createDocumentLocaleSource,
  hasPermission,
  IconButton,
  type LocaleTranslator,
  SettingsPage as SettingsPageLayout,
  SettingsState,
  UiLocaleProvider,
  type UiLocaleSource,
  useUiText,
} from '@agnes/web-ui'
import { revealSettingsAnchor, settingsMoved } from '@agnes/web-units'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { PluginAdminApi } from '../admin/plugins/api.js'
import { PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog } from '../admin/plugins/locales/admin.js'
import type { AdminContext } from '../admin/plugins/types.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import type { RuntimeSettingsContext } from './registry.js'
import './registry.js'

export type SettingsAdmin = Readonly<{ api: PluginAdminApi; context: AdminContext }>
type Admin = SettingsAdmin

const readAdmin = async (): Promise<Admin> => {
  const context = await PluginAdminApi.context()
  return { api: new PluginAdminApi(context), context }
}

/** A section the dialog renders itself: registered, without a native pane, and not moved elsewhere. */
function ownedSection(id: string | undefined) {
  const entry = id ? settingsSections.get(id) : undefined
  return entry && !entry.nativePane && !settingsMoved(entry.id) ? entry : undefined
}

function requestedPage(): string | undefined {
  return document.querySelector<HTMLElement>('#config-form')?.dataset.runtimePage
}

let documentLocale: UiLocaleSource | undefined

/**
 * The settings dialog's own pages: every section without a native pane, one at a time, in the
 * shared page template. It reads the admin context itself, so it does not depend on the plugin
 * page being mounted. `hostText` resolves keys the host registered, such as a plugin section's title.
 */
export function SettingsPages({
  hostText,
  admin = readAdmin,
}: {
  hostText?: LocaleTranslator
  /** Reads the admin connection; the default asks the daemon the page is served by. */
  admin?: () => Promise<SettingsAdmin>
}) {
  // Each panel carries its own catalog; the source only supplies the language and its changes.
  documentLocale ??= createDocumentLocaleSource({}).source
  return (
    <UiLocaleProvider source={documentLocale}>
      <SettingsPageHost hostText={hostText} load={admin} />
    </UiLocaleProvider>
  )
}

function SettingsPageHost({
  hostText,
  load,
}: {
  hostText?: LocaleTranslator | undefined
  load: () => Promise<SettingsAdmin>
}) {
  useSyncExternalStore(settingsSections.subscribe, settingsSections.getSnapshot)
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const { t: pluginText } = useUiText(PLUGIN_ADMIN_LOCALE_NAMESPACE, pluginAdminLocaleCatalog)
  // Nothing is read until the dialog first shows one of these pages.
  const [page, setPage] = useState<string | undefined>(() => ownedSection(requestedPage())?.id)
  const [admin, setAdmin] = useState<Admin>()
  const [generations, setGenerations] = useState<PluginGenerationStatus>()
  const [snapshot, setSnapshot] = useState<RuntimeAdminSnapshot>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const section = ownedSection(page)
  const needsRuntimeCatalog = !!section && section.runtimeCatalog !== false

  useEffect(() => {
    const listener = (event: Event) => {
      const id = ownedSection(String((event as CustomEvent<unknown>).detail))?.id
      if (id) setPage(id)
    }
    document.addEventListener('agnes:settings-page', listener)
    return () => document.removeEventListener('agnes:settings-page', listener)
  }, [])

  const active = !!section
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit refresh.
  useEffect(() => {
    if (!active) return
    let current = true
    void load().then(
      (value) => {
        if (!current) return
        // An unchanged context keeps its connection, so a refresh reads each catalog once.
        setAdmin((known) =>
          known && JSON.stringify(known.context) === JSON.stringify(value.context) ? known : value,
        )
        // The plugin version list is one optional read; the panel that shows it reports its absence.
        void Promise.resolve()
          .then(() => value.api.generations())
          .then(
            (status) => {
              if (current) setGenerations(status)
            },
            () => undefined,
          )
      },
      // Each page reports its own failed reads; without the context every save stays disabled.
      () => {
        if (current) setAdmin(undefined)
      },
    )
    return () => {
      current = false
    }
  }, [active, revision, load])

  const api = admin?.api
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an explicit refresh.
  useEffect(() => {
    let current = true
    if (!needsRuntimeCatalog) setSnapshot(undefined)
    setFailed(false)
    setBusy(false)
    if (!api || !needsRuntimeCatalog) return
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
  }, [api, revision, needsRuntimeCatalog])

  useEffect(() => {
    if (!page) return
    const hash = location.hash.slice(1)
    if (hash.startsWith('settings-subsection-')) requestAnimationFrame(() => revealSettingsAnchor(hash))
  }, [page])

  const navigate = useCallback((id: string) => {
    document
      .getElementById('config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: id, bubbles: true }))
  }, [])
  const onRefresh = useCallback(async () => setRevision((value) => value + 1), [])
  const text = useMemo(
    () => (key: string, vars?: Record<string, string | number>) => {
      const value = t(key, vars)
      return value === key && hostText ? hostText(key, vars) : value
    },
    [t, hostText],
  )
  if (!section) return null
  const title = (() => {
    const value = text(section.titleKey)
    return value === section.titleKey ? text(section.id) : value
  })()
  const canSave =
    !!admin && !admin.context.readOnly && hasPermission(admin.context.permissions, 'packages.activate')
  const data: RuntimeSettingsContext = {
    api,
    canSave,
    canRelease:
      !!admin && !admin.context.readOnly && hasPermission(admin.context.permissions, 'packages.remove'),
    canInstall:
      !!admin && !admin.context.readOnly && hasPermission(admin.context.permissions, 'packages.install'),
    pluginText,
    installed: [],
    generations,
    onRefresh,
    onReview: () => {},
    navigate,
    snapshot,
  }
  const Component = section.component
  return (
    <div data-testid={`settings-page-${section.id}`} id={`settings-hub-panel-${section.id}`}>
      <SettingsPageLayout
        title={title}
        actions={
          needsRuntimeCatalog ? (
            // The page loads on open and after each action; a manual reload stays one quiet icon.
            <IconButton
              name="refresh-cw"
              label={t('retry')}
              data-testid="settings-refresh"
              {...(!api ? { disabledReason: t('unavailable') } : {})}
              disabled={!api || busy}
              aria-busy={busy}
              onClick={() => setRevision((value) => value + 1)}
            />
          ) : undefined
        }
      >
        {needsRuntimeCatalog && busy && !snapshot && (
          <SettingsState tone="loading" data-testid="settings-catalog-state">
            {t('loading')}
          </SettingsState>
        )}
        {needsRuntimeCatalog && failed && (
          <Banner tone="error" data-testid="settings-catalog-state">
            {t('unavailable')}
          </Banner>
        )}
        <Component key={section.id} context={{ t: text, data }} />
      </SettingsPageLayout>
    </div>
  )
}
