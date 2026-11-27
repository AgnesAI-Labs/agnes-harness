import { Tabs, useUiText } from '@agnes/web-ui'
import { type ReactNode, useMemo, useState } from 'react'
import { PluginConfigApi } from './config-api.js'
import { PLUGIN_CONFIG_ADMIN_NAMESPACE, pluginConfigAdminCatalog } from './config-locale.js'
import { PluginConfigPanel } from './config-panel.js'
import type { AdminContext } from './types.js'

/** The detail surface groups existing content without changing configuration or approval semantics. */
export function PluginConfigTab({
  context,
  id,
  installed,
  children,
  permissions,
  versions,
  docs,
  settingsSummary,
}: {
  /** The plugin's documentation, mounted only while its tab is selected. */
  docs?: ReactNode
  context: AdminContext
  id: string
  installed: boolean
  children: ReactNode
  permissions?: ReactNode
  versions?: ReactNode
  settingsSummary?: ReactNode
  onClose(): void
}) {
  const { t } = useUiText(PLUGIN_CONFIG_ADMIN_NAMESPACE, pluginConfigAdminCatalog)
  const [tab, setTab] = useState('details')
  const [configOpened, setConfigOpened] = useState(false)
  const { profile, clientId } = context
  const api = useMemo(() => new PluginConfigApi({ profile, clientId }), [profile, clientId])
  if (tab === 'docs' && !docs) setTab('details')
  return (
    <Tabs
      id={`plugin-config-tab-${encodeURIComponent(id)}`}
      activeKey={tab}
      onChange={(next) => {
        setTab(next)
        if (next === 'config') setConfigOpened(true)
      }}
      items={[
        {
          key: 'details',
          label: <span data-testid="plugin-details-tab">{t('details')}</span>,
          // The tab body is plain flow; the stack gives its sections the same vertical rhythm as
          // the settings pages instead of the margins each part happens to carry.
          children: <div className="plugin-detail-stack">{children}</div>,
        },
        ...(installed
          ? [
              {
                key: 'config',
                label: <span data-testid="plugin-config-tab">{t('config')}</span>,
                children: (
                  <div className="plugin-detail-stack">
                    {settingsSummary}
                    {configOpened && (
                      <PluginConfigPanel
                        api={api}
                        id={id}
                        canSave={!context.readOnly && context.permissions.includes('packages.activate')}
                      />
                    )}
                  </div>
                ),
              },
            ]
          : []),
        ...(permissions
          ? [
              {
                key: 'permissions',
                label: <span data-testid="plugin-permissions-tab">{t('permissions')}</span>,
                children: permissions,
              },
            ]
          : []),
        ...(versions
          ? [
              {
                key: 'versions',
                label: <span data-testid="plugin-versions-tab">{t('versions')}</span>,
                children: versions,
              },
            ]
          : []),
        ...(docs
          ? [
              {
                key: 'docs',
                label: <span data-testid="plugin-docs-tab">{t('docs')}</span>,
                children: tab === 'docs' ? docs : undefined,
              },
            ]
          : []),
      ]}
    />
  )
}
