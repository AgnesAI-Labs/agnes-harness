import { Button, useUiText } from '@agnes/web-ui'
import { type ReactNode, useMemo, useState } from 'react'
import { PluginConfigApi } from './config-api.js'
import { PLUGIN_CONFIG_ADMIN_NAMESPACE, pluginConfigAdminCatalog } from './config-locale.js'
import { PluginConfigPanel } from './config-panel.js'
import type { AdminContext } from './types.js'

/** Detail owns its existing actions; this mount adds the configuration tab without coupling to them. */
export function PluginConfigTab({
  context,
  id,
  installed,
  children,
  onClose,
}: {
  context: AdminContext
  id: string
  installed: boolean
  children: ReactNode
  onClose(): void
}) {
  const { t } = useUiText(PLUGIN_CONFIG_ADMIN_NAMESPACE, pluginConfigAdminCatalog)
  const [tab, setTab] = useState<'details' | 'config'>('details')
  const [configOpened, setConfigOpened] = useState(false)
  const { profile, clientId } = context
  const api = useMemo(() => new PluginConfigApi({ profile, clientId }), [profile, clientId])
  const selectTab = (name: 'details' | 'config') => {
    setTab(name)
    if (name === 'config') setConfigOpened(true)
  }
  const tabId = `plugin-config-tab-${encodeURIComponent(id)}`
  if (!installed) return <>{children}</>
  return (
    <>
      <div role="tablist" aria-label={id}>
        {(['details', 'config'] as const).map((name) => (
          <Button
            key={name}
            htmlType="button"
            role="tab"
            id={`${tabId}-${name}`}
            aria-selected={tab === name}
            aria-controls={`${tabId}-panel-${name}`}
            tabIndex={tab === name ? 0 : -1}
            data-testid={`plugin-${name}-tab`}
            onClick={() => selectTab(name)}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 'details'
                    : event.key === 'End'
                      ? 'config'
                      : tab === 'config'
                        ? 'details'
                        : 'config'
                selectTab(next)
                document.getElementById(`${tabId}-${next}`)?.focus()
              }
            }}
          >
            {t(name)}
          </Button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabId}-panel-details`}
        aria-labelledby={`${tabId}-details`}
        hidden={tab !== 'details'}
      >
        {children}
      </div>
      <div
        role="tabpanel"
        id={`${tabId}-panel-config`}
        aria-labelledby={`${tabId}-config`}
        hidden={tab !== 'config'}
      >
        {configOpened && (
          <>
            <div className="plugin-detail-heading">
              <h2>{id}</h2>
              <Button htmlType="button" onClick={onClose}>
                {t('close')}
              </Button>
            </div>
            <div className="admin-detail-scroll">
              <PluginConfigPanel
                api={api}
                id={id}
                canSave={!context.readOnly && context.permissions.includes('packages.activate')}
              />
            </div>
          </>
        )}
      </div>
    </>
  )
}
