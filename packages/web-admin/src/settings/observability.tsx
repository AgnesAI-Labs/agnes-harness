import type { AdminObservabilityResult, ObservabilitySettings } from '@agnes/protocol/gen/app-server'
import {
  Button,
  Field,
  SettingsCard,
  SettingsDetails,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { observabilityRequest } from './observability-api.js'
import { observabilityCatalog } from './observability-locale.js'

export function ObservabilityPanel({ canSave = true }: { canSave?: boolean }) {
  const { t } = useUiText('@agnes/web/observability', observabilityCatalog)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<AdminObservabilityResult>()
  const [config, setConfig] = useState<ObservabilitySettings>({ enabled: false, redaction: 'metadata' })
  const [headers, setHeaders] = useState('{}')
  const [busy, setBusy] = useState(true)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    void observabilityRequest({}, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return
        setSnapshot(value)
        setConfig(value.settings)
        setHeaders(JSON.stringify(value.settings.headers ?? {}, null, 2))
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [])
  async function request(action: 'save' | 'test' | 'refresh') {
    if (busy) return
    setBusy(true)
    setNotice('')
    setError(false)
    try {
      const settings: ObservabilitySettings =
        action === 'refresh' ? config : { ...config, headers: JSON.parse(headers) }
      if (action !== 'refresh' && !settings.endpoint) delete settings.endpoint
      const value = await observabilityRequest(
        action === 'refresh' ? {} : { settings, ...(action === 'test' ? { test: true } : {}) },
        lifetime.current?.signal,
      )
      if (lifetime.current?.signal.aborted) return
      setSnapshot(value)
      setNotice(
        action === 'save'
          ? 'saved'
          : value.connection === 'ok'
            ? 'ok'
            : value.connection === 'failed'
              ? 'failed'
              : '',
      )
    } catch {
      if (!lifetime.current?.signal.aborted) setError(true)
    } finally {
      if (!lifetime.current?.signal.aborted) setBusy(false)
    }
  }
  const health = snapshot?.health
  return (
    <SettingsCard title={t('title')} data-testid="otlp-settings" aria-busy={busy}>
      <p>{t('help')}</p>
      {error && (
        <SettingsState tone="error" role="alert" data-testid="otlp-error">
          {t('error')}
        </SettingsState>
      )}
      {notice && (
        <SettingsState
          tone={notice === 'failed' ? 'error' : 'success'}
          role="status"
          data-testid="otlp-notice"
        >
          {t(notice)}
        </SettingsState>
      )}
      <Field htmlFor="otlp-enabled" label={t('enabled')}>
        <SettingsSelect
          id="otlp-enabled"
          data-testid="otlp-enabled"
          disabled={busy || !canSave}
          value={config.enabled ? 'on' : 'off'}
          onChange={(event) => setConfig({ ...config, enabled: event.target.value === 'on' })}
        >
          <option value="off">{t('disabled')}</option>
          <option value="on">{t('enabled')}</option>
        </SettingsSelect>
      </Field>
      <Field htmlFor="otlp-endpoint" label={t('endpoint')}>
        <SettingsInput
          id="otlp-endpoint"
          data-testid="otlp-endpoint"
          disabled={busy || !canSave}
          value={config.endpoint ?? ''}
          onChange={(event) => setConfig({ ...config, endpoint: event.target.value })}
        />
      </Field>
      <Field htmlFor="otlp-redaction" label={t('redaction')}>
        <SettingsSelect
          id="otlp-redaction"
          data-testid="otlp-redaction"
          disabled={busy || !canSave}
          value={config.redaction ?? 'metadata'}
          onChange={(event) =>
            setConfig({ ...config, redaction: event.target.value as 'metadata' | 'content' })
          }
        >
          <option value="metadata">{t('metadata')}</option>
          <option value="content">{t('content')}</option>
        </SettingsSelect>
      </Field>
      {config.redaction === 'content' && (
        <SettingsState tone="empty" data-testid="otlp-privacy">
          {t('privacy')}
        </SettingsState>
      )}
      <SettingsDetails title={t('limits')} data-testid="otlp-limits">
        {(['batchSize', 'batchMs', 'queueSize', 'timeoutMs'] as const).map((key) => (
          <Field key={key} htmlFor={`otlp-${key}`} label={t(key)}>
            <SettingsInput
              id={`otlp-${key}`}
              data-testid={`otlp-${key}`}
              type="number"
              min={key === 'batchMs' || key === 'timeoutMs' ? 10 : 1}
              max={key === 'batchMs' || key === 'timeoutMs' ? 30000 : 16384}
              disabled={busy || !canSave}
              value={config[key] ?? { batchSize: 256, batchMs: 1000, queueSize: 1024, timeoutMs: 3000 }[key]}
              onChange={(event) => setConfig({ ...config, [key]: Number(event.target.value) })}
            />
          </Field>
        ))}
        <Field htmlFor="otlp-shutdown" label={t('shutdown')}>
          <SettingsSelect
            id="otlp-shutdown"
            data-testid="otlp-shutdown"
            disabled={busy || !canSave}
            value={config.shutdownPolicy ?? 'flush'}
            onChange={(event) =>
              setConfig({ ...config, shutdownPolicy: event.target.value as 'flush' | 'discard' })
            }
          >
            <option value="flush">{t('flush')}</option>
            <option value="discard">{t('discard')}</option>
          </SettingsSelect>
        </Field>
        <Field htmlFor="otlp-headers" label={t('headers')}>
          <SettingsTextArea
            id="otlp-headers"
            data-testid="otlp-headers"
            disabled={busy || !canSave}
            value={headers}
            onChange={(event) => setHeaders(event.target.value)}
          />
        </Field>
        <p>{t('headerHelp')}</p>
      </SettingsDetails>
      <SettingsToolbar>
        <Button data-testid="otlp-save" disabled={busy || !canSave} onClick={() => void request('save')}>
          {t('save')}
        </Button>
        <Button
          data-testid="otlp-test"
          disabled={
            busy ||
            !canSave ||
            !(config.endpoint || (config.tracesEndpoint && config.metricsEndpoint && config.logsEndpoint))
          }
          onClick={() => void request('test')}
        >
          {t('test')}
        </Button>
        <Button data-testid="otlp-refresh" disabled={busy} onClick={() => void request('refresh')}>
          {t('refresh')}
        </Button>
      </SettingsToolbar>
      <p data-testid="otlp-health">
        {t('status')}: {health ? t(health.status === 'ok' ? 'healthy' : health.status) : t('never')}
      </p>
      <p data-testid="otlp-last">
        {t('last')}: {health?.lastExportAt ?? t('never')}
      </p>
      <p data-testid="otlp-drops">
        {t('dropped')}: {health?.dropped ?? 0} · {t('queued')}: {health?.queued ?? 0} · {t('failures')}:{' '}
        {health?.failures ?? 0}
      </p>
      <p>{t('scope')}</p>
      <p data-testid="otlp-worker">
        {t('worker')}:{' '}
        {snapshot?.workerHealth
          ? t(snapshot.workerHealth.status === 'ok' ? 'healthy' : snapshot.workerHealth.status)
          : t(snapshot?.workerState === 'unavailable' ? 'workerUnavailable' : 'workerIdle')}{' '}
        · {t('dropped')}: {snapshot?.workerHealth?.dropped ?? 0} · {t('queued')}:{' '}
        {snapshot?.workerHealth?.queued ?? 0} · {t('failures')}: {snapshot?.workerHealth?.failures ?? 0} ·{' '}
        {t('last')}: {snapshot?.workerHealth?.lastExportAt ?? t('never')}
      </p>
    </SettingsCard>
  )
}
