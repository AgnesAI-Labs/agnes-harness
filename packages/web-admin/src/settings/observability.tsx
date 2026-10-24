import type { AdminObservabilityResult, ObservabilitySettings } from '@agnes/protocol/gen/app-server'
import {
  Banner,
  Button,
  Field,
  fallbackT,
  IconButton,
  reportSuccess,
  SettingsBlock,
  SettingsChoice,
  SettingsDrill,
  SettingsGroup,
  SettingsInput,
  SettingsItem,
  SettingsPresetSelect,
  SettingsTag,
  StateSwitch,
  secondPresets,
  trackPageRequest,
  useAutosave,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { captureRequest } from './async-request.js'
import { observabilityRequest } from './observability-api.js'
import { observabilityCatalog } from './observability-locale.js'

const DEFAULTS = { batchSize: 256, batchMs: 1000, queueSize: 1024, timeoutMs: 3000 } as const
const sameSettings = (a: ObservabilitySettings, b: ObservabilitySettings) =>
  JSON.stringify(a) === JSON.stringify(b)
type Health = AdminObservabilityResult['health']
const healthTone = (status: Health['status'] | undefined) =>
  status === 'ok' ? 'ok' : status === 'backoff' || status === 'rejected' ? 'warn' : 'muted'

/**
 * OTLP export under Integrations: one row with its state; its subpage switches export on, sets the collector,
 * header secret references (one row each), the content policy and, one level deeper, the batch and
 * delivery limits. Every change saves itself; the status below can test the collector.
 */
export function ObservabilityPanel({ canSave = true }: { canSave?: boolean }) {
  // Permission changes start a new autosave owner as well as a new read lifetime.
  return <ObservabilitySettingsPanel key={String(canSave)} canSave={canSave} />
}

function ObservabilitySettingsPanel({ canSave }: { canSave: boolean }) {
  const { t } = useUiText('@agnes/web/observability', observabilityCatalog)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const [snapshot, setSnapshot] = useState<AdminObservabilityResult>()
  const [busy, setBusy] = useState(true)
  const [readFailed, setReadFailed] = useState(false)
  const [notice, setNotice] = useState<'' | 'ok' | 'failed'>('')
  const [header, setHeader] = useState({ name: '', env: '' })
  const [headerErrors, setHeaderErrors] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useEffect(() => {
    const abort = new AbortController()
    lifetime.current = abort
    setBusy(true)
    void trackPageRequest(observabilityRequest({}, abort.signal))
      .then((value) => {
        if (!abort.signal.aborted) setSnapshot(value)
      })
      .catch(() => {
        if (!abort.signal.aborted) setReadFailed(true)
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false)
      })
    return () => abort.abort()
  }, [canSave])
  const settings = useAutosave<ObservabilitySettings>({
    resourceKey: 'settings:observability',
    onSaved: () => reportSuccess('settings:observability', fallbackT('ui.settingsSaved')),
    stored: snapshot?.settings,
    equal: sameSettings,
    save: async (next) => {
      const request = captureRequest(lifetime)
      if (!request.isCurrent()) return
      const value = await observabilityRequest({ settings: next }, request.signal)
      if (request.isCurrent()) setSnapshot(value)
    },
  })
  async function request(action: 'test' | 'refresh') {
    if (busy) return
    const request = captureRequest(lifetime)
    setBusy(true)
    setNotice('')
    try {
      const value = await observabilityRequest(
        action === 'refresh' || !settings.value ? {} : { settings: settings.value, test: true },
        request.signal,
      )
      if (!request.isCurrent()) return
      setSnapshot(value)
      if (action === 'test')
        setNotice(value.connection === 'ok' ? 'ok' : value.connection === 'failed' ? 'failed' : '')
    } catch {
      if (request.isCurrent()) setNotice('failed')
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  const value = settings.value ?? { enabled: false }
  const locked = !canSave || !snapshot
  const edit = (patch: Partial<ObservabilitySettings>, when: 'now' | 'idle' = 'now') => {
    const next = { ...value, ...patch }
    if (!next.endpoint) delete next.endpoint
    settings.set(next, when)
  }
  type Headers = Record<string, { secretRef: string }>
  const headers = Object.entries((value.headers ?? {}) as Headers)
  const health = snapshot?.health
  const statusText = (status: Health['status'] | undefined) =>
    status ? t(status === 'ok' ? 'healthy' : status) : t('never')
  const seconds = secondPresets([1, 5, 10, 30], (count) => t('seconds', { count }))
  const addHeader = () => {
    const name = header.name.trim().toLowerCase()
    const env = header.env.trim().replace(/^env:/, '')
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || !/^[A-Z_][A-Z0-9_]*$/.test(env)) {
      setHeaderErrors(true)
      document
        .querySelector<HTMLElement>(
          !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)
            ? '[data-testid="otlp-header-name"]'
            : '[data-testid="otlp-header-env"]',
        )
        ?.focus()
      return
    }
    setHeaderErrors(false)
    edit({ headers: { ...(value.headers ?? {}), [name]: { secretRef: `env:${env}` } } })
    setHeader({ name: '', env: '' })
  }
  return (
    <SettingsDrill
      id="otlp"
      data-testid="otlp-settings"
      label={t('row')}
      title={t('title')}
      description={t('help')}
      value={
        snapshot ? (
          <SettingsTag tone={value.enabled ? healthTone(health?.status) : 'muted'} data-testid="otlp-state">
            {value.enabled ? statusText(health?.status) : t('disabled')}
          </SettingsTag>
        ) : undefined
      }
    >
      <SettingsBlock
        aria-busy={busy || settings.busy}
        failed={settings.failed}
        onRetry={settings.retry}
        state={readFailed ? 'error' : busy && !snapshot ? 'loading' : undefined}
      >
        <SettingsItem label={t('enabled')}>
          <StateSwitch
            id="otlp-enabled"
            testId="otlp-enabled"
            label={t('enabled')}
            checked={value.enabled}
            disabled={locked}
            onToggle={(enabled) => edit({ enabled })}
          />
        </SettingsItem>
        <SettingsItem label={t('endpoint')}>
          <SettingsInput
            id="otlp-endpoint"
            data-testid="otlp-endpoint"
            className="agnes-settings-wide"
            aria-label={t('endpoint')}
            placeholder="https://collector.example.com"
            disabled={locked}
            value={value.endpoint ?? ''}
            onChange={(event) => edit({ endpoint: event.target.value }, 'idle')}
            onBlur={settings.flush}
          />
        </SettingsItem>
        <SettingsItem label={t('headers')} description={t('headerHint')} data-testid="otlp-headers">
          <span className="agnes-settings-toolbar-row">
            <Field
              label={t('headerName')}
              error={
                headerErrors && !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(header.name.trim().toLowerCase())
                  ? t('headerNameError')
                  : undefined
              }
            >
              <SettingsInput
                aria-label={t('headerName')}
                placeholder={t('headerName')}
                data-testid="otlp-header-name"
                disabled={locked}
                value={header.name}
                onChange={(event) => setHeader({ ...header, name: event.target.value })}
              />
            </Field>
            <Field
              label={t('headerEnv')}
              error={
                headerErrors && !/^[A-Z_][A-Z0-9_]*$/.test(header.env.trim().replace(/^env:/, ''))
                  ? t('headerEnvError')
                  : undefined
              }
            >
              <SettingsInput
                aria-label={t('headerEnv')}
                placeholder={t('headerEnvExample')}
                data-testid="otlp-header-env"
                disabled={locked}
                value={header.env}
                onChange={(event) => setHeader({ ...header, env: event.target.value })}
              />
            </Field>
            <Button size="small" data-testid="otlp-header-add" disabled={locked} onClick={addHeader}>
              {t('add')}
            </Button>
          </span>
        </SettingsItem>
        {headers.map(([name, ref]) => (
          <SettingsItem
            key={name}
            label={<code>{name}</code>}
            description={ref.secretRef}
            data-testid="otlp-header"
          >
            <IconButton
              name="trash-2"
              label={t('removeHeader', { name })}
              disabled={locked}
              onClick={() => {
                const next: Headers = { ...((value.headers ?? {}) as Headers) }
                delete next[name]
                edit({ headers: next })
              }}
            />
          </SettingsItem>
        ))}
        <SettingsItem label={t('redaction')}>
          <SettingsGroup
            role="radiogroup"
            aria-label={t('redaction')}
            data-testid="otlp-redaction"
            className="agnes-settings-choices"
          >
            <SettingsChoice
              type="radio"
              name="otlp-redaction"
              value="metadata"
              label={t('metadata')}
              checked={(value.redaction ?? 'metadata') === 'metadata'}
              disabled={locked}
              onChange={() => edit({ redaction: 'metadata' })}
            />
            <SettingsChoice
              type="radio"
              name="otlp-redaction"
              value="content"
              label={t('content')}
              checked={(value.redaction ?? 'metadata') === 'content'}
              disabled={locked}
              onChange={() => edit({ redaction: 'content' })}
            />
          </SettingsGroup>
        </SettingsItem>
        <SettingsItem label={t('scopeLabel')}>
          <span className="agnes-settings-value">{t('scope')}</span>
        </SettingsItem>
        <SettingsDrill
          id="otlp-limits"
          data-testid="otlp-limits"
          label={t('limits')}
          value={
            (['batchSize', 'batchMs', 'queueSize', 'timeoutMs', 'shutdownPolicy'] as const).some(
              (key) => value[key] !== undefined,
            )
              ? t('customized')
              : t('defaults')
          }
        >
          <SettingsBlock failed={settings.failed} onRetry={settings.retry}>
            {(['batchSize', 'queueSize'] as const).map((key) => (
              <SettingsItem key={key} label={t(key)}>
                <SettingsInput
                  id={`otlp-${key}`}
                  data-testid={`otlp-${key}`}
                  type="number"
                  min={1}
                  max={16384}
                  className="agnes-settings-number"
                  aria-label={t(key)}
                  disabled={locked}
                  value={value[key] ?? DEFAULTS[key]}
                  onChange={(event) => {
                    const next = Number(event.target.value)
                    if (Number.isInteger(next) && next >= 1 && next <= 16384) edit({ [key]: next }, 'idle')
                  }}
                  onBlur={settings.flush}
                />
              </SettingsItem>
            ))}
            {(['batchMs', 'timeoutMs'] as const).map((key) => (
              <SettingsItem key={key} label={t(key)}>
                <SettingsPresetSelect
                  id={`otlp-${key}`}
                  data-testid={`otlp-${key}`}
                  label={t(key)}
                  defaultLabel={t('defaultSeconds', { count: DEFAULTS[key] / 1000 })}
                  disabled={locked}
                  value={value[key]}
                  presets={seconds}
                  unit={t('secondUnit')}
                  scale={1000}
                  onChange={(next) => {
                    const rest = { ...value }
                    if (next === undefined) delete rest[key]
                    settings.set(next === undefined ? rest : { ...rest, [key]: next })
                  }}
                />
              </SettingsItem>
            ))}
            <SettingsItem label={t('shutdown')}>
              <SettingsGroup
                role="radiogroup"
                aria-label={t('shutdown')}
                data-testid="otlp-shutdown"
                className="agnes-settings-choices"
              >
                <SettingsChoice
                  type="radio"
                  name="otlp-shutdown"
                  value="flush"
                  label={t('flush')}
                  checked={(value.shutdownPolicy ?? 'flush') === 'flush'}
                  disabled={locked}
                  onChange={() => edit({ shutdownPolicy: 'flush' })}
                />
                <SettingsChoice
                  type="radio"
                  name="otlp-shutdown"
                  value="discard"
                  label={t('discard')}
                  checked={(value.shutdownPolicy ?? 'flush') === 'discard'}
                  disabled={locked}
                  onChange={() => edit({ shutdownPolicy: 'discard' })}
                />
              </SettingsGroup>
            </SettingsItem>
          </SettingsBlock>
        </SettingsDrill>
      </SettingsBlock>
      {value.redaction === 'content' && (
        <Banner tone="warning" data-testid="otlp-privacy">
          {t('privacy')}
        </Banner>
      )}
      {notice && (
        <Banner tone={notice === 'ok' ? 'info' : 'error'} role="status" data-testid="otlp-notice">
          {t(notice)}
        </Banner>
      )}
      <SettingsBlock
        label={t('statusGroup')}
        actions={
          <>
            <Button
              size="small"
              data-testid="otlp-test"
              disabled={
                busy ||
                !canSave ||
                !(value.endpoint || (value.tracesEndpoint && value.metricsEndpoint && value.logsEndpoint))
              }
              onClick={() => void request('test')}
            >
              {t('test')}
            </Button>
            <Button
              size="small"
              data-testid="otlp-refresh"
              disabled={busy}
              onClick={() => void request('refresh')}
            >
              {t('refresh')}
            </Button>
          </>
        }
      >
        <SettingsItem label={t('status')}>
          <span className="agnes-settings-value" data-testid="otlp-health">
            {statusText(health?.status)}
          </span>
        </SettingsItem>
        <SettingsItem label={t('last')}>
          <span className="agnes-settings-value" data-testid="otlp-last">
            {health?.lastExportAt ?? t('never')}
          </span>
        </SettingsItem>
        <SettingsItem label={t('counts')}>
          <span className="agnes-settings-value" data-testid="otlp-drops">
            {t('countsValue', {
              queued: health?.queued ?? 0,
              dropped: health?.dropped ?? 0,
              failures: health?.failures ?? 0,
            })}
          </span>
        </SettingsItem>
        <SettingsItem label={t('worker')}>
          <span className="agnes-settings-value" data-testid="otlp-worker">
            {snapshot?.workerHealth
              ? `${statusText(snapshot.workerHealth.status)} · ${t('countsValue', {
                  queued: snapshot.workerHealth.queued,
                  dropped: snapshot.workerHealth.dropped,
                  failures: snapshot.workerHealth.failures,
                })}`
              : t(snapshot?.workerState === 'unavailable' ? 'workerUnavailable' : 'workerIdle')}
          </span>
        </SettingsItem>
      </SettingsBlock>
    </SettingsDrill>
  )
}
