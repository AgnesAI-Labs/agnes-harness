import { type DiagnosticRecord, type DiagnosticsExportResult, errorMessageKey } from '@agnes/protocol'
import {
  appServerErrorMessage,
  Badge,
  Button,
  Field,
  SettingsCard,
  SettingsDetails,
  SettingsInput,
  SettingsList,
  SettingsRow,
  SettingsState,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import {
  type DiagnosticsApi,
  DiagnosticsRequestError,
  diagnosticsApi,
  downloadDiagnostics,
} from './diagnostics-api.js'
import { DIAGNOSTICS_NAMESPACE, diagnosticsCatalog } from './diagnostics-locale.js'

const browserApi = diagnosticsApi()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function DiagnosticsPanel({
  api = browserApi,
  download = downloadDiagnostics,
}: {
  api?: DiagnosticsApi
  download?: (bundle: DiagnosticsExportResult) => void
}) {
  const { t } = useUiText(DIAGNOSTICS_NAMESPACE, diagnosticsCatalog)
  const [bundle, setBundle] = useState<DiagnosticsExportResult>()
  const [doctorAvailable, setDoctorAvailable] = useState(false)
  const [checks, setChecks] = useState<Array<{ name: string; status: string }>>()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState('')
  const alive = useRef(false)
  const controller = useRef<AbortController>()
  useEffect(() => {
    alive.current = true
    const pending = new AbortController()
    controller.current = pending
    setBusy(true)
    void api
      .read(pending.signal)
      .then((value) => {
        if (!pending.signal.aborted) {
          setBundle(value.bundle)
          setDoctorAvailable(value.doctorAvailable)
          setError(undefined)
        }
      })
      .catch((failure: unknown) => {
        if (!pending.signal.aborted) setError(failure)
      })
      .finally(() => {
        if (!pending.signal.aborted) setBusy(false)
      })
    return () => {
      alive.current = false
      pending.abort()
    }
  }, [api])
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setNotice('')
    try {
      await action()
    } catch (failure) {
      if (alive.current) setError(failure)
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  async function search() {
    const id = query.trim()
    if (id && !uuid.test(id)) {
      setNotice('invalid')
      return
    }
    await run(async () => {
      const result = await api.export(id ? { diagnosticId: id } : {}, controller.current?.signal)
      if (alive.current) {
        setBundle(result)
        setSelected(id)
      }
    })
  }
  const locale = document.documentElement.lang || 'en'
  const message = (record: DiagnosticRecord) => {
    const key = errorMessageKey(record.cause ?? record.name)
    return (
      appServerErrorMessage(
        { data: { messageKey: key === 'appServer.errors.internal' ? errorMessageKey(record.name) : key } },
        locale,
      ) ?? t('unavailable')
    )
  }
  const failure = error instanceof DiagnosticsRequestError ? error.envelope : undefined
  const telemetry = bundle?.telemetry
  const boundSessions = bundle?.generations.available
    ? bundle.generations.items.reduce((count, row) => count + row.boundSessions, 0)
    : undefined
  const workerStatus = bundle?.doctor.find((row) => row.name === 'worker')?.status
  const workerIdle = boundSessions === 0 && (!workerStatus || workerStatus === 'unavailable')
  return (
    <>
      <p>{t('help')}</p>
      {busy && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {error && (
        <SettingsState tone="error" data-testid="diagnostics-failure">
          {appServerErrorMessage(failure, locale) ?? t('unavailable')}
        </SettingsState>
      )}
      {notice && <SettingsState data-testid="diagnostics-notice">{t(notice)}</SettingsState>}
      <SettingsCard title={t('recent')} data-testid="diagnostics-errors" aria-busy={busy}>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void search()
          }}
        >
          <Field label={t('id')} htmlFor="diagnostics-query">
            <SettingsInput
              id="diagnostics-query"
              surface="surface"
              data-testid="diagnostics-query"
              value={query}
              maxLength={36}
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <div className="agnes-settings-actions">
            <Button htmlType="submit" data-testid="diagnostics-search" disabled={busy}>
              {t('search')}
            </Button>
            <Button
              disabled={busy}
              data-testid="diagnostics-refresh"
              onClick={() => {
                setQuery('')
                void run(async () => {
                  const value = await api.read(controller.current?.signal)
                  if (alive.current) {
                    setBundle(value.bundle)
                    setDoctorAvailable(value.doctorAvailable)
                    setSelected('')
                  }
                })
              }}
            >
              {t('refresh')}
            </Button>
          </div>
        </form>
        <p>{t('latest')}</p>
        {!busy && bundle && bundle.errors.length === 0 && <SettingsState>{t('empty')}</SettingsState>}
        <SettingsList>
          {bundle?.errors
            .slice(-100)
            .reverse()
            .map((record) => (
              <SettingsRow
                key={record.diagnosticId}
                title={message(record)}
                data-testid="diagnostics-error"
                description={
                  <time dateTime={record.at} data-testid="diagnostics-error-time">
                    {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
                      new Date(record.at),
                    )}
                  </time>
                }
                actions={
                  <Button
                    data-testid="diagnostics-copy"
                    onClick={() => {
                      void Promise.resolve()
                        .then(() => navigator.clipboard.writeText(record.diagnosticId))
                        .then(
                          () => {
                            if (alive.current) setNotice('copied')
                          },
                          () => {
                            if (alive.current) setNotice('copyFailed')
                          },
                        )
                    }}
                  >
                    {t('copy')}
                  </Button>
                }
              >
                <p>
                  {t('id')}: <code data-testid="diagnostics-error-id">{record.diagnosticId}</code>
                </p>
                <SettingsDetails title={t('technical')} compact>
                  <p>
                    {t('code')}: <code data-testid="diagnostics-error-code">{record.code}</code>
                  </p>
                  <code>{record.name}</code>
                  {record.cause && (
                    <p>
                      <code>{record.cause}</code>
                    </p>
                  )}
                </SettingsDetails>
              </SettingsRow>
            ))}
        </SettingsList>
      </SettingsCard>
      <SettingsCard title={t('export')}>
        <p>{t('exportHelp')}</p>
        <p>{t('exportReview')}</p>
        <Button
          data-testid="diagnostics-export"
          disabled={busy || !bundle}
          onClick={() =>
            void run(async () => {
              const value = await api.export(
                selected ? { diagnosticId: selected } : {},
                controller.current?.signal,
              )
              if (alive.current) {
                download(value)
                setNotice('exported')
              }
            })
          }
        >
          {t('export')}
        </Button>
      </SettingsCard>
      <SettingsCard title={t('telemetry')} data-testid="diagnostics-telemetry">
        <SettingsList>
          <SettingsRow
            title={t('status')}
            actions={
              <Badge tone={telemetry?.enabled ? 'ok' : 'off'}>
                {t(telemetry ? (telemetry.enabled ? 'enabled' : 'disabled') : 'unknown')}
              </Badge>
            }
          />
          <SettingsRow title={t('collector')}>
            <span data-testid="diagnostics-endpoint">
              {telemetry ? telemetry.endpointHosts.join(', ') || t('notConfigured') : t('unknown')}
            </span>
          </SettingsRow>
          <SettingsRow
            title={t('content')}
            actions={
              <Badge tone={telemetry?.includeContent ? 'warn' : 'off'}>
                {t(telemetry ? (telemetry.includeContent ? 'enabled' : 'disabled') : 'unknown')}
              </Badge>
            }
          />
        </SettingsList>
        {telemetry?.includeContent && (
          <SettingsState tone="error" data-testid="diagnostics-content-warning">
            {t('risk')}
          </SettingsState>
        )}
        <p>{t('readOnly')}</p>
        <a
          href={`https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/guide/observability${locale.startsWith('zh') ? '.zh-CN' : ''}.md`}
          target="_blank"
          rel="noreferrer"
        >
          {t('docs')}
        </a>
      </SettingsCard>
      <SettingsCard title={t('runtime')} data-testid="diagnostics-runtime">
        <SettingsRow title={t('worker')}>
          <Badge>{workerIdle ? t('workerIdle') : t(`state.${workerStatus ?? 'unavailable'}`)}</Badge>
        </SettingsRow>
        <SettingsRow title={t('generations')}>
          <span>{bundle?.generations.available ? bundle.generations.items.length : t('unknown')}</span>
        </SettingsRow>
        <SettingsRow title={t('bound')}>
          <span>{boundSessions ?? t('unknown')}</span>
        </SettingsRow>
        <SettingsDetails title={t('technical')} data-testid="diagnostics-runtime-details" compact>
          {bundle && (
            <>
              <p>
                {t('collected')}: <time dateTime={bundle.collectedAt}>{bundle.collectedAt}</time>
              </p>
              <p>
                {bundle.agh.version} · {bundle.runtime.platform} · Node {bundle.runtime.node}
              </p>
            </>
          )}
          {bundle?.generations.items.map((row) => (
            <p key={row.idHash}>
              <code>{row.idHash}</code> · {t(`state.${row.state}`)} · {row.boundSessions}
            </p>
          ))}
        </SettingsDetails>
      </SettingsCard>
      {doctorAvailable && (
        <SettingsCard title={t('doctor')} data-testid="diagnostics-doctor">
          <p>{t('doctorHelp')}</p>
          <Button
            data-testid="diagnostics-doctor-run"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const value = await api.doctor(controller.current?.signal)
                if (alive.current) setChecks(value)
              })
            }
          >
            {t('runDoctor')}
          </Button>
          {checks?.map((row) => (
            <SettingsRow
              key={row.name}
              title={diagnosticsCatalog.en[`check.${row.name}`] ? t(`check.${row.name}`) : t('otherCheck')}
            >
              <Badge>{t(`state.${row.status}`)}</Badge>
            </SettingsRow>
          ))}
        </SettingsCard>
      )}
    </>
  )
}
