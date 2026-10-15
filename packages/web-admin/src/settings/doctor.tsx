import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import {
  appServerErrorMessage,
  Button,
  DoctorChecks,
  DoctorGroups,
  type DoctorWorker,
  FIRST_RUN_NAMESPACE,
  firstRunCatalog,
  Icon,
  SettingsBlock,
  SettingsDetails,
  SettingsState,
  SettingsToolbar,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useEffect, useState } from 'react'
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

/** Grouped diagnostics; all health facts come from the existing doctor and diagnostic DTOs. */
export function DoctorRows({
  load,
  label,
  worker,
  version,
  node,
  service,
  footerActions,
}: {
  load(probe: boolean, signal: AbortSignal): Promise<DoctorResult>
  label?: string
  worker?: DoctorWorker | undefined
  version?: string | undefined
  node?: string | undefined
  service: DoctorWorker
  footerActions?: ReactNode
}) {
  const { t: ux } = useUiText(DIAGNOSTICS_NAMESPACE, diagnosticsCatalog)
  const { t, locale } = useUiText(FIRST_RUN_NAMESPACE, firstRunCatalog)
  const [report, setReport] = useState<DoctorResult>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<unknown>()
  const [request, setRequest] = useState({ revision: 0, probe: false })
  const [checkedAt, setCheckedAt] = useState<number>()
  const [now, setNow] = useState(Date.now)
  const [announcement, setAnnouncement] = useState<'finished' | 'failed'>()
  useEffect(() => {
    const cancel = new AbortController()
    let current = true
    setBusy(true)
    setError(undefined)
    setAnnouncement(undefined)
    void load(request.probe, cancel.signal)
      .then((value) => {
        if (!current) return
        setReport(value)
        const finished = Date.now()
        setCheckedAt(finished)
        setNow(finished)
        setAnnouncement('finished')
      })
      .catch((value) => {
        if (current) {
          setError(value)
          setAnnouncement('failed')
        }
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
      cancel.abort()
    }
  }, [request, load])
  useEffect(() => {
    if (checkedAt === undefined) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [checkedAt])
  const run = (probe = false) => setRequest((previous) => ({ revision: previous.revision + 1, probe }))
  const minutes = checkedAt === undefined ? 0 : Math.max(0, Math.floor((now - checkedAt) / 60_000))
  return (
    <SettingsBlock
      bare
      label={label}
      data-testid="diagnostics-doctor"
      className="agnes-doctor"
      aria-busy={busy}
      actions={
        <>
          <Button
            size="small"
            data-testid="diagnostics-doctor-run"
            disabled={busy}
            aria-busy={busy}
            onClick={() => run()}
          >
            <span className="agnes-doctor-refresh" data-checking={busy}>
              <Icon name="refresh-cw" />
            </span>
            {t('doctor.run')}
          </Button>
        </>
      }
    >
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="agnes-doctor-sr"
        data-testid="doctor-announcement"
      >
        {announcement ? t(`doctor.${announcement}`) : ''}
      </span>
      {error !== undefined && (
        <div role="alert" className="agnes-doctor-failure">
          {appServerErrorMessage(error instanceof DiagnosticsRequestError ? error.envelope : error, locale) ??
            t('doctor.failed')}
          <Button size="small" data-testid="doctor-retry" onClick={() => run()}>
            {ux('retry')}
          </Button>
        </div>
      )}
      <DoctorGroups
        footer={
          <div className="agnes-doctor-footer" data-checking={busy} data-state={service.status}>
            <span className="agnes-doctor-service">
              <span className="agnes-doctor-service-dot" aria-hidden="true" />
              {ux('service')}
              {service.text}
            </span>
            <span className="agnes-doctor-meta">
              {[version, node ? `Node ${node}` : undefined].filter(Boolean).join(' · ')}
              {checkedAt !== undefined && (
                <>
                  {' '}
                  ·{' '}
                  <time data-testid="doctor-checked-at" dateTime={new Date(checkedAt).toISOString()}>
                    {minutes < 1
                      ? t('doctor.justNow')
                      : t('doctor.minutesAgo', { count: new Intl.NumberFormat(locale).format(minutes) })}
                  </time>
                </>
              )}
            </span>
            <span className="agnes-doctor-footer-actions">{footerActions}</span>
          </div>
        }
        onProbe={() => run(true)}
        report={report}
        busy={busy || !report}
        worker={worker}
        workerLabel={ux('worker')}
        node={node}
        t={t}
        locale={locale}
        onNavigate={(destination) =>
          document
            .getElementById('config-form')
            ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: destination, bubbles: true }))
        }
      />
    </SettingsBlock>
  )
}
