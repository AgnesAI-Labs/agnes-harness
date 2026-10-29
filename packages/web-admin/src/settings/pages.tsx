import { settingsSections } from '@agnes/web-client'
import {
  Banner,
  Button,
  createDocumentLocaleSource,
  hasPermission,
  Loadable,
  type LocaleTranslator,
  SettingsPage as SettingsPageLayout,
  scopedResourceKey,
  UiLocaleProvider,
  type UiLocaleSource,
  useResource,
  useUiText,
} from '@agnes/web-ui'
import { revealSettingsAnchor, settingsMoved } from '@agnes/web-units/shell'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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

  const connection = useRef<Admin>()
  const adminRead = useResource(section ? scopedResourceKey(load, 'settings:admin') : undefined, async () => {
    const next = await load()
    // Keep one connection and cache identity when a focus refresh returns the same capabilities.
    return connection.current && JSON.stringify(connection.current.context) === JSON.stringify(next.context)
      ? connection.current
      : next
  })
  const admin = adminRead.data
  connection.current = admin
  const api = admin?.api
  const runtimeRead = useResource(
    api && needsRuntimeCatalog ? scopedResourceKey(api, `settings:runtime:${page}`) : undefined,
    () => {
      if (!api) throw new Error('Admin unavailable')
      return api.runtime()
    },
  )
  const generationRead = useResource(
    api && section ? scopedResourceKey(api, 'settings:generations') : undefined,
    () => {
      if (!api) throw new Error('Admin unavailable')
      return api.generations()
    },
  )
  const snapshot = runtimeRead.data
  const generations = generationRead.data
  const adminFailed = !!adminRead.error
  const failed = !!runtimeRead.error
  const adminBusy = adminRead.loading
  const busy = runtimeRead.loading

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
  const onRefresh = async () => {
    adminRead.reload()
    runtimeRead.reload()
    generationRead.reload()
  }
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
    !!admin &&
    !adminFailed &&
    !admin.context.readOnly &&
    hasPermission(admin.context.permissions, 'packages.activate')
  const data: RuntimeSettingsContext = {
    api,
    canSave,
    canRelease:
      !!admin &&
      !adminFailed &&
      !admin.context.readOnly &&
      hasPermission(admin.context.permissions, 'packages.remove'),
    canTrust:
      !!admin &&
      !adminFailed &&
      !admin.context.readOnly &&
      hasPermission(admin.context.permissions, 'packages.trust'),
    canInstall:
      !!admin &&
      !adminFailed &&
      !admin.context.readOnly &&
      hasPermission(admin.context.permissions, 'packages.install'),
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
    <div
      data-testid={`settings-page-${section.id}`}
      id={`settings-hub-panel-${section.id}`}
      aria-busy={adminBusy || busy}
    >
      <SettingsPageLayout
        // Another page starts at its top level, not inside the last page's subpage.
        key={section.id}
        routeId={section.id}
        title={title}
      >
        {needsRuntimeCatalog && (adminBusy || busy) && !snapshot && (
          <Loadable loading hasData={false} shape="rows" />
        )}
        {(adminFailed || (needsRuntimeCatalog && failed)) && (
          <Banner tone="error" data-testid="settings-catalog-state">
            {t('readFailed')} ·{' '}
            <Button
              type="text"
              size="small"
              data-testid="settings-retry"
              onClick={() => {
                if (adminFailed) adminRead.reload()
                else runtimeRead.reload()
              }}
            >
              {t('retry')}
            </Button>
          </Banner>
        )}
        <Component key={section.id} context={{ t: text, data }} />
      </SettingsPageLayout>
    </div>
  )
}
