import type { Client } from '@agnes/sdk/browser'
import { type LocaleService, settingsSections } from '@agnes/web-client'
import {
  Button,
  SettingsGroup,
  SettingsItem,
  SettingsSelect,
  SettingsToolbar,
  useDocumentLanguage,
} from '@agnes/web-ui'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { CloudConnectionIndicator } from './cloud-connection-status.js'
import { cloudFailureText } from './cloud-errors.js'
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
  const [credentialRef, setCredentialRef] = useState(state.credentialRef ?? '')
  const [selecting, setSelecting] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setSelecting(false)
    setCredentialRef(state.credentialRef ?? '')
  }, [state.credentialRef])
  useEffect(() => {
    if (!selecting && (state.status !== 'connecting' || Boolean(state.error)))
      setCredentialRef(state.credentialRef ?? '')
  }, [selecting, state.credentialRef, state.status, state.error])
  const connect = () => {
    if (!state.credentialOptions?.some((item) => item.id === credentialRef)) {
      setError(t('keyRequired'))
      return
    }
    setSelecting(false)
    onAction({ action: 'connect', credentialRef })
    setError('')
  }
  return (
    <>
      <SettingsGroup>
        <SettingsItem label={t('cloudStatus')} description={t('cloudHelp')}>
          <CloudConnectionIndicator status={state.status} t={t} />
        </SettingsItem>
        <SettingsItem label={<label htmlFor="cloud-service-credential">{t('cloudKey')}</label>} stacked>
          <SettingsSelect
            id="cloud-service-credential"
            value={credentialRef}
            disabled={!state.credentialOptions || state.status === 'connecting'}
            onFocus={() => onAction({ action: 'refresh-credentials' })}
            onChange={(event) => {
              setSelecting(true)
              setCredentialRef(event.target.value)
              setError('')
            }}
          >
            <option value="">
              {state.credentialOptions?.length ? t('keyRequired') : t('credentialsEmpty')}
            </option>
            {state.credentialOptions?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
                {state.credentialOptions?.filter((other) => other.label === item.label).length !== 1
                  ? ` · ${item.id.slice(-8)}`
                  : ''}
              </option>
            ))}
          </SettingsSelect>
          <SettingsToolbar>
            <Button appearance="ghost" onClick={() => onAction({ action: 'manage-credentials' })}>
              {t('manageCredentials')}
            </Button>
            <Button appearance="ghost" onClick={() => onAction({ action: 'refresh-credentials' })}>
              {t('refreshCredentials')}
            </Button>
          </SettingsToolbar>
          {state.credentialError && <p role="alert">{t('credentialsUnavailable')}</p>}
        </SettingsItem>
      </SettingsGroup>
      {(error || state.error) && (
        <p role="alert">
          {error || (state.error?.startsWith('CLOUD_') ? cloudFailureText(state.error) : state.error)}
        </p>
      )}
      <SettingsToolbar>
        <Button appearance="primary" disabled={state.status === 'connecting'} onClick={connect}>
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
  useEffect(() => requestCloudConnection({ action: 'refresh-credentials' }), [])
  return <CloudConnectionSettings state={state} onAction={requestCloudConnection} />
}

/** Browser connection settings belong to A, independent of the selected backend's configuration. */
export function installCloudConnectionSettings(
  locale: LocaleService,
  client: Pick<Client, 'on'>,
): () => void {
  if (backendFrame()) return () => {}
  const projectionOff = installCloudSettingsProjection(client)
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
