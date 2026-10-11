import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import {
  appServerErrorMessage,
  Button,
  DoctorChecks,
  FIRST_RUN_NAMESPACE,
  firstRunCatalog,
  SettingsDetails,
  SettingsState,
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
