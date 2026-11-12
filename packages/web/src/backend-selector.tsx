import { remoteFrontendOrigin } from '@agnes/protocol'
import { Button, SettingsInput, SettingsPage, useDocumentLanguage } from '@agnes/web-ui'
import { useState } from 'react'
import { backendSelectorCatalog } from './backend-selector-locale.js'
import { backendFrame, requestBackendEnvironment } from './backends/frame-context.js'
import { selectedRemoteOrigin } from './remote-frontend.js'

function useText() {
  const language = useDocumentLanguage()
  const catalog = backendSelectorCatalog[language === 'zh-CN' ? 'zh-CN' : 'en']
  return (key: keyof typeof backendSelectorCatalog.en) => catalog[key]
}
export function backendHref(remote?: string): string {
  const url = new URL(location.href)
  // A fresh environment must never inherit another backend's session, startup input or admin route.
  url.search = ''
  url.hash = ''
  if (remote) url.searchParams.set('remote', remoteFrontendOrigin(remote))
  return `${url.pathname}${url.search}`
}
export function BackendSelector() {
  const t = useText()
  const remote = selectedRemoteOrigin()
  return (
    <Button
      size="small"
      aria-label={t('switch')}
      onClick={() => {
        const url = new URL(backendHref(remote), location.origin)
        url.searchParams.set('connection', '1')
        location.assign(`${url.pathname}${url.search}`)
      }}
    >
      {remote ? `${t('remote')} · ${new URL(remote).host}` : t('current')}
    </Button>
  )
}
export function ConnectionPage({
  message = '',
  remote,
  onConnect,
  onLocal,
}: {
  message?: string
  remote?: string
  onConnect?(origin: string): void
  onLocal?(): void
}) {
  const t = useText()
  const [address, setAddress] = useState(remote ?? selectedRemoteOrigin() ?? '')
  const [error, setError] = useState(message)
  const connect = () => {
    try {
      const origin = remoteFrontendOrigin(address.trim())
      if (onConnect) onConnect(origin)
      else if (!requestBackendEnvironment(origin)) location.assign(backendHref(origin))
    } catch {
      setError(t('invalid'))
    }
  }
  return (
    <main className="remote-connection-page">
      <SettingsPage
        title={t('title')}
        description={t('help')}
        actions={
          <Button
            onClick={() => {
              if (onLocal) onLocal()
              else if (!requestBackendEnvironment()) location.assign(backendHref())
            }}
          >
            {t('local')}
          </Button>
        }
      >
        <p>{t('help')}</p>
        <label htmlFor="remote-frontend-origin">{t('label')}</label>
        <SettingsInput
          id="remote-frontend-origin"
          value={address}
          placeholder="http://192.168.1.20:8443"
          onChange={(event) => {
            setAddress(event.target.value)
            setError('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') connect()
          }}
        />
        {error && <p role="alert">{error}</p>}
        <div>
          <Button type="primary" onClick={connect}>
            {t('connect')}
          </Button>
        </div>
      </SettingsPage>
    </main>
  )
}
export function RemoteFrontendFailure({ message }: { message: string }) {
  const t = useText()
  if (!backendFrame()) return <ConnectionPage message={message} />
  return (
    <SettingsPage title={t('failed')}>
      <p role="alert">{message}</p>
      <p>{t('retrySettings')}</p>
    </SettingsPage>
  )
}
