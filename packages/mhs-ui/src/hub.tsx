import { Button } from '@agnes/web-ui'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { stateLabel } from './locales.js'
import { jsonText } from './model.js'
import type { HubStatus } from './ports.js'
import { useMhs, useQuery } from './react.js'

type Hub = { value?: HubStatus | undefined; error: boolean; blocked: boolean; retry(): void }
const HubContext = createContext<Hub>({ error: false, blocked: false, retry() {} })
export const useHub = () => useContext(HubContext)
export function HubProvider({ children }: { children: ReactNode }) {
  const { client, store } = useMhs(),
    port = client.ports.developer
  const query = useQuery(
    useCallback(async (signal: AbortSignal) => port?.status(signal), [port]),
    true,
  )
  useEffect(() => {
    if (
      !query.value ||
      (!['starting', 'stopping'].includes(query.value.state) && query.value.mode !== 'external')
    )
      return
    const timer = setTimeout(query.retry, 2000)
    return () => clearTimeout(timer)
  }, [query.value, query.retry])
  useEffect(() => {
    if (query.value?.state === 'ready') void store.refresh()
  }, [query.value?.state, store])
  return (
    <HubContext.Provider
      value={{ ...query, blocked: !!port && (query.error || query.value?.state !== 'ready') }}
    >
      {children}
    </HubContext.Provider>
  )
}
export function HubDependency({ panel }: { panel: 'devices' | 'map' | 'activity' | 'examples' }) {
  const { t } = useMhs()
  return (
    <p role="status" className="mhs-dependency">
      {t(`hubBlocked.${panel}`)} <a href="#mhs-hub-status">{t('goHub')}</a>
    </p>
  )
}
export function HubHealth() {
  const { client, t } = useMhs(),
    status = useHub(),
    port = client.ports.developer
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false)
  const recover = async () => {
    if (!port || busy) return
    setBusy(true)
    setFailed(false)
    try {
      if (status.error) status.retry()
      else {
        await (status.value?.state === 'shutdown-unconfirmed' ? port.reconcile() : port.retry())
        status.retry()
      }
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div id="mhs-hub-status" className="mhs-hub-status" tabIndex={-1}>
      <span role="status">
        {!port ? (
          t('noDeveloper')
        ) : (
          <>
            Hub{status.value?.mode && <> · {t(status.value.mode === 'local' ? 'localHub' : 'externalHub')}</>}{' '}
            ·{' '}
            {status.error
              ? t('hubRequestFailed')
              : status.value
                ? stateLabel(t, status.value.state)
                : t('loading')}
          </>
        )}
      </span>
      {port &&
        (status.error ||
          status.value?.state === 'failed' ||
          status.value?.state === 'shutdown-unconfirmed') && (
          <Button appearance="primary" loading={busy} onClick={() => void recover()}>
            {t(status.value?.state === 'shutdown-unconfirmed' && !status.error ? 'confirmRecover' : 'retry')}
          </Button>
        )}
      {failed && <p role="alert">{t('hubRecoveryFailed')}</p>}
      {status.value?.code && (
        <details>
          <summary>{t('details')}</summary>
          <pre>{jsonText(status.value)}</pre>
        </details>
      )}
    </div>
  )
}
