import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import {
  appServerErrorMessage,
  Button,
  DoctorChecks,
  FIRST_RUN_NAMESPACE,
  firstRunCatalog,
  SettingsBlock,
  SettingsDetails,
  SettingsItem,
  SettingsState,
  SettingsTag,
  SettingsToolbar,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { DiagnosticsRequestError } from './diagnostics-api.js'
import { DIAGNOSTICS_NAMESPACE, diagnosticsCatalog } from './diagnostics-locale.js'

export function DoctorPanel({ load }: { load(probe: boolean, signal: AbortSignal): Promise<DoctorResult> }) {
  const { t: ux } = useUiText(DIAGNOSTICS_NAMESPACE, diagnosticsCatalog)
  const { t, locale } = useUiText(FIRST_RUN_NAMESPACE, firstRunCatalog)
  const [report, setReport] = useState<DoctorResult>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(),
    [request, setRequest] = useState({ revision: 0, probe: false })
  useEffect(() => {
    const cancel = new AbortController()
    let current = true
    setBusy(true)
    setError(undefined)
    void load(request.probe, cancel.signal)
      .then((value) => {
        if (current) setReport(value)
      })
      .catch((value) => {
        if (current) setError(value)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
      cancel.abort()
    }
  }, [request, load])
  return (
    <section aria-label={t('doctor.title')} data-testid="doctor-panel">
      <p>{t('doctor.intro')}</p>
      <SettingsToolbar>
        <Button
          data-testid="diagnostics-doctor-run"
          loading={busy}
          onClick={() => setRequest({ revision: request.revision + 1, probe: false })}
        >
          {t('doctor.run')}
        </Button>
        <Button
          data-testid="doctor-probe-accounts"
          disabled={busy}
          onClick={() => setRequest({ revision: request.revision + 1, probe: true })}
        >
          {t('doctor.probe')}
        </Button>
      </SettingsToolbar>
      {busy && <SettingsState tone="loading">{t('doctor.loading')}</SettingsState>}
      {error !== undefined && (
        <SettingsState tone="error">
          {appServerErrorMessage(error instanceof DiagnosticsRequestError ? error.envelope : error, locale) ??
            t('doctor.failed')}
        </SettingsState>
      )}
      {report && (
        <>
          <p role="status" data-testid="diagnostics-health-summary">
            {report.checks.every((check) => check.status === 'ok')
              ? ux('healthy')
              : `${new Intl.NumberFormat(locale).format(report.checks.filter((check) => check.status !== 'ok').length)} ${ux('needsAttention')}`}
          </p>
          <SettingsDetails title={ux('checkDetails')} data-testid="diagnostics-check-details">
            <DoctorChecks report={report} t={t} locale={locale} />
          </SettingsDetails>
        </>
      )}
    </section>
  )
}

const CHECK_TONE = { ok: 'ok', warn: 'warn', fail: 'error' } as const

/**
 * 状态检查 on 运行时与诊断: each check one row with its state mark; a check that needs attention says
 * how to fix it. 重新检查 runs it again; 测试模型账户 also tries each model account.
 */
export function DoctorRows({
  load,
  worker,
  version,
}: {
  load(probe: boolean, signal: AbortSignal): Promise<DoctorResult>
  /** The background worker's state, in words. */
  worker?: string | undefined
  /** The background service's version line. */
  version?: string | undefined
}) {
  const { t: ux } = useUiText(DIAGNOSTICS_NAMESPACE, diagnosticsCatalog)
  const { t, locale } = useUiText(FIRST_RUN_NAMESPACE, firstRunCatalog)
  const [report, setReport] = useState<DoctorResult>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [request, setRequest] = useState({ revision: 0, probe: false })
  useEffect(() => {
    const cancel = new AbortController()
    let current = true
    setBusy(true)
    setError(undefined)
    void load(request.probe, cancel.signal)
      .then((value) => {
        if (current) setReport(value)
      })
      .catch((value) => {
        if (current) setError(value)
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
      cancel.abort()
    }
  }, [request, load])
  return (
    <SettingsBlock
      data-testid="diagnostics-doctor"
      aria-busy={busy}
      actions={
        <>
          <Button
            size="small"
            data-testid="diagnostics-doctor-run"
            loading={busy && !request.probe}
            onClick={() => setRequest({ revision: request.revision + 1, probe: false })}
          >
            {t('doctor.run')}
          </Button>
          <Button
            size="small"
            data-testid="doctor-probe-accounts"
            disabled={busy}
            onClick={() => setRequest({ revision: request.revision + 1, probe: true })}
          >
            {t('doctor.probe')}
          </Button>
        </>
      }
      state={busy && !report ? 'loading' : undefined}
    >
      {error !== undefined && (
        <SettingsItem
          role="alert"
          label={
            appServerErrorMessage(
              error instanceof DiagnosticsRequestError ? error.envelope : error,
              locale,
            ) ?? t('doctor.failed')
          }
        />
      )}
      {version && (
        <SettingsItem label={ux('service')}>
          <span className="agnes-settings-value">
            <SettingsTag tone="ok">{ux('running')}</SettingsTag>
            {version}
          </span>
        </SettingsItem>
      )}
      {report?.checks.map((check) => (
        <SettingsItem
          key={check.id}
          data-testid={`doctor-check-${check.id}`}
          label={t(`doctor.check.${check.id}`)}
          description={check.status === 'ok' ? undefined : t(check.fixHintKey)}
        >
          <SettingsTag tone={CHECK_TONE[check.status]}>{t(`doctor.status.${check.status}`)}</SettingsTag>
        </SettingsItem>
      ))}
      {worker && (
        <SettingsItem label={ux('worker')}>
          <span className="agnes-settings-value" data-testid="diagnostics-worker">
            {worker}
          </span>
        </SettingsItem>
      )}
    </SettingsBlock>
  )
}
