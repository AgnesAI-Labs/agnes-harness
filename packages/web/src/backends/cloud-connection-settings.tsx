import { remoteFrontendOrigin } from '@agnes/protocol'
import { type LocaleService, settingsSections } from '@agnes/web-client'
import {
  Button,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsToolbar,
  useDocumentLanguage,
} from '@agnes/web-ui'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { CloudConnectionIndicator } from './cloud-connection-status.js'
import {
  CLOUD_SETTINGS_SECTION,
  type CloudConnectionAction,
  cloudSettingsState,
  installCloudSettingsProjection,
  requestCloudConnection,
} from './cloud-settings-bridge.js'
import { backendFrame } from './frame-context.js'
import { workbenchCatalog } from './workbench-locale.js'
import type { CloudConnectionState } from './workbench-state.js'

export function CloudConnectionSettings({
  state,
  onAction,
}: {
  state: CloudConnectionState
  onAction(action: CloudConnectionAction): void
}) {
  const language = useDocumentLanguage()
  const catalog = workbenchCatalog[language === 'zh-CN' ? 'zh-CN' : 'en']
  const t = (key: keyof typeof catalog) => catalog[key]
  const [address, setAddress] = useState(state.origin ?? '')
  const [error, setError] = useState('')
  useEffect(() => setAddress(state.origin ?? ''), [state.origin])
  const connect = () => {
    try {
      onAction({ action: 'connect', origin: remoteFrontendOrigin(address.trim()) })
      setError('')
    } catch {
      setError(t('invalidOrigin'))
    }
  }
  return (
    <>
      <SettingsGroup>
        <SettingsItem label={t('cloudStatus')} description={t('cloudHelp')}>
          <CloudConnectionIndicator status={state.status} t={t} />
        </SettingsItem>
        <SettingsItem label={<label htmlFor="cloud-service-origin">{t('cloudOrigin')}</label>} stacked>
          <SettingsInput
            id="cloud-service-origin"
            value={address}
            placeholder="http://192.168.1.20:8443"
            onChange={(event) => {
              setAddress(event.target.value)
              setError('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                connect()
              }
            }}
          />
        </SettingsItem>
      </SettingsGroup>
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
      <SettingsToolbar>
        <Button appearance="primary" onClick={connect}>
          {t('saveConnect')}
        </Button>
        {state.origin && (
          <>
            <Button onClick={() => onAction({ action: 'reconnect' })}>{t('retry')}</Button>
            <Button onClick={() => onAction({ action: 'disconnect' })}>{t('disconnect')}</Button>
          </>
        )}
      </SettingsToolbar>
    </>
  )
}

function CloudConnectionSection() {
  const state = useSyncExternalStore(cloudSettingsState.subscribe, cloudSettingsState.read)
  return <CloudConnectionSettings state={state} onAction={requestCloudConnection} />
}

/** Browser connection settings belong to A, independent of the selected backend's configuration. */
export function installCloudConnectionSettings(locale: LocaleService): () => void {
  if (!backendFrame()) return () => {}
  const projectionOff = installCloudSettingsProjection()
  const localeOff = locale.register('@agnes/cloud-connection', {
    en: { 'settings-shell.page.cloud-connection': 'Cloud connection' },
    'zh-CN': { 'settings-shell.page.cloud-connection': '云端连接' },
  })
  const sectionOff = settingsSections.register({
    id: CLOUD_SETTINGS_SECTION,
    group: 'advanced',
    order: 35,
    icon: 'globe',
    titleKey: 'settings-shell.page.cloud-connection',
    groupTitleKey: 'settings-shell.advanced',
    runtimeCatalog: false,
    component: CloudConnectionSection,
  })
  return () => {
    sectionOff()
    localeOff()
    projectionOff()
  }
}
