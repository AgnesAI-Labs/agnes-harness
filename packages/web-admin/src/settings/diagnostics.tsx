import type { DiagnosticRecord, DiagnosticsExportResult } from '@agnes/protocol'
import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import {
  appServerErrorMessage,
  Button,
  Dialog,
  FIRST_RUN_NAMESPACE,
  Field,
  firstRunCatalog,
  Icon,
  IconButton,
  reportSuccess,
  SettingsBlock,
  SettingsDrill,
  SettingsInput,
  SettingsItem,
  SettingsTag,
  StatusMessage,
  trackPageRequest,
  useSettingsSubpages,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { captureRequest } from './async-request.js'
import {
  type DiagnosticsApi,
  DiagnosticsRequestError,
  diagnosticsApi,
  downloadDiagnostics,
} from './diagnostics-api.js'
import { errorDrillId, errorsEntry, RecentErrors } from './diagnostics-errors.js'
import { DIAGNOSTICS_NAMESPACE, diagnosticsCatalog } from './diagnostics-locale.js'
import { DoctorRows } from './doctor.js'
import { ObservabilityPanel } from './observability.js'
import { useSettingsOverlay } from './overlay.js'

const browserApi = diagnosticsApi()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

/**
 * 运行时与诊断: status checks in four compact groups (重新检查, 测试模型账户), recent errors by day
 * and kind as a subpage with an ID lookup (see RecentErrors), and 集成 (OTLP export and the runtime details as
 * subpages). The page header copies a summary and exports a redacted bundle after saying what it
 * contains; after a lookup finds an error, the bundle holds only that error.
 */
export function DiagnosticsPanel({
  api = browserApi,
  download = downloadDiagnostics,
  integrations,
  maintenance,
}: {
  api?: DiagnosticsApi
  download?: (bundle: DiagnosticsExportResult) => void
  /** More rows of 集成 (the runtime details), given by the page. */
  integrations?: ReactNode
  maintenance?: ReactNode
}) {
  const { t } = useUiText(DIAGNOSTICS_NAMESPACE, diagnosticsCatalog)
  const { t: doctorText } = useUiText(FIRST_RUN_NAMESPACE, firstRunCatalog)
  const [doctorChecks, setDoctorChecks] = useState<DoctorResult['checks']>()
  const [bundle, setBundle] = useState<DiagnosticsExportResult>()
  const [doctorAvailable, setDoctorAvailable] = useState(false)
  const [exporting, setExporting] = useState(false)
  const loadChecks = useCallback(
    async (probe: boolean, signal: AbortSignal) => {
      const result = await api.doctor(signal, probe)
      if (!signal.aborted) setDoctorChecks(result.checks)
      return result
    },
    [api],
  )
  const { stack, open } = useSettingsSubpages()
  // The latest stack, read when a lookup returns: the user may have left the list meanwhile.
  const stackNow = useRef(stack)
  stackNow.current = stack
  const [query, setQuery] = useState('')
  const [lookup, setLookup] = useState<{ id: string; records: DiagnosticRecord[] }>()
  const selected = lookup?.records.length ? lookup.id : ''
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState('')
  const copyRetry = useRef<() => void>(() => {})
  const [reads, setReads] = useState(0)
  const controller = useRef<AbortController>()
  useSettingsOverlay(exporting)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
  useEffect(() => {
    const pending = new AbortController()
    controller.current = pending
    setBusy(true)
    void trackPageRequest(api.read(pending.signal))
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
      pending.abort()
    }
  }, [api, reads])
  async function run(action: (request: ReturnType<typeof captureRequest>) => Promise<void>) {
    if (busy) return
    const request = captureRequest(controller)
    setBusy(true)
    setError(undefined)
    setNotice('')
    try {
      await action(request)
    } catch (failure) {
      if (request.isCurrent()) setError(failure)
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  const clear = () => {
    setQuery('')
    setLookup(undefined)
    setNotice('')
  }
  async function search() {
    const id = query.trim()
    if (!id) return clear()
    if (!uuid.test(id)) {
      setNotice('invalid')
      document.getElementById('diagnostics-query')?.focus()
      return
    }
    await run(async (request) => {
      const result = await api.export({ diagnosticId: id }, request.signal)
      if (request.isCurrent()) {
        setLookup({ id, records: result.errors })
        // A found error opens on its own page, under the list that now holds only it,
        // unless the user has left the list while the request ran.
        if (result.errors[0] && stackNow.current.at(-1) === 'errors') open(errorDrillId(result.errors[0]))
      }
    })
  }
  const locale = document.documentElement.lang || 'en'
  const copy = (value: string, done: string) => {
    copyRetry.current = () => copy(value, done)
    const request = captureRequest(controller)
    setNotice('')
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => {
          if (request.isCurrent()) reportSuccess('diagnostics', t(done))
        },
        () => {
          if (request.isCurrent()) setNotice('copyFailed')
        },
      )
  }
  const failure = error instanceof DiagnosticsRequestError ? error.envelope : undefined
  const boundSessions = bundle?.generations.available
    ? bundle.generations.items.reduce((count, row) => count + row.boundSessions, 0)
    : undefined
  const serviceStatus = bundle?.doctor.find((row) => row.name === 'daemon')?.status ?? 'ok'
  const workerStatus = bundle?.doctor.find((row) => row.name === 'worker')?.status
  const workerIdle = boundSessions === 0 && (!workerStatus || workerStatus === 'unavailable')
  const counts = bundle && errorsEntry(bundle.errors)
  // What the entry row says: nothing while reading, otherwise the state of the latest day or all kinds.
  const entry = error ? (
    <SettingsTag tone="error">{t('readFailed')}</SettingsTag>
  ) : !counts ? undefined : !counts.kinds ? (
    <SettingsTag tone="ok">{t('noErrors')}</SettingsTag>
  ) : counts.today ? (
    `${t('today')} ${t('dayCounts', { kinds: counts.today.kinds, count: counts.today.count })}`
  ) : (
    t('kindsTotal', { kinds: counts.kinds })
  )
  const footerActions = (
    <>
      <Button
        type="text"
        size="small"
        data-testid="diagnostics-summary-copy"
        disabled={!bundle}
        onClick={() => {
          if (!bundle) return
          const summary = [
            t('title'),
            `${t('recent')}: ${bundle.errors.length}`,
            ...(doctorChecks
              ? doctorChecks.map(
                  (check) =>
                    `${doctorText(`doctor.check.${check.id}`)}: ${doctorText(`doctor.status.${check.status}`)}`,
                )
              : bundle.doctor.map(
                  (check) =>
                    `${t(`check.${check.name}`) === `check.${check.name}` ? t('otherCheck') : t(`check.${check.name}`)}: ${t(`state.${check.status}`)}`,
                )),
          ].join('\n')
          copy(summary, 'summaryCopied')
        }}
      >
        <Icon name="copy" />
        {t('copySummary')}
      </Button>
      <Button
        type="text"
        size="small"
        data-testid="diagnostics-export"
        disabled={busy || !bundle}
        onClick={() => setExporting(true)}
      >
        <Icon name="download" />
        {t('export')}
      </Button>
    </>
  )
  return (
    <>
      {notice === 'copyFailed' && stack.length === 0 && (
        <StatusMessage
          kind="error"
          data-testid="diagnostics-notice"
          action={{ label: t('retry'), onSelect: () => copyRetry.current() }}
        >
          {t(notice)}
        </StatusMessage>
      )}
      {doctorAvailable ? (
        <DoctorRows
          footerActions={footerActions}
          label={t('doctor')}
          load={loadChecks}
          worker={{
            text: workerIdle ? t('workerIdle') : t(`state.${workerStatus ?? 'unavailable'}`),
            status: workerStatus ?? 'unavailable',
          }}
          version={bundle?.agh.version}
          node={bundle?.runtime.node}
          service={{
            text: serviceStatus === 'ok' ? t('running') : t(`state.${serviceStatus}`),
            status: serviceStatus,
          }}
        />
      ) : (
        <SettingsBlock label={t('doctor')} data-testid="diagnostics-worker-only">
          <div className="agnes-doctor-footer">{footerActions}</div>
          <SettingsItem label={t('worker')}>
            <span className="agnes-settings-value" data-testid="diagnostics-worker">
              {workerIdle ? t('workerIdle') : t(`state.${workerStatus ?? 'unavailable'}`)}
            </span>
          </SettingsItem>
        </SettingsBlock>
      )}
      {maintenance}
      <SettingsDrill
        id="errors"
        data-testid="diagnostics-errors-row"
        label={t('recent')}
        value={entry}
        actions={
          <span className="agnes-diagnostics-lookup">
            <Field label={t('findById')} error={notice === 'invalid' ? t('invalid') : undefined}>
              <SettingsInput
                id="diagnostics-query"
                surface="surface"
                data-testid="diagnostics-query"
                className="agnes-settings-search"
                aria-label={t('findById')}
                placeholder={t('findById')}
                value={query}
                maxLength={36}
                disabled={busy}
                onChange={(event) => {
                  setQuery(event.target.value)
                  if (notice === 'invalid') setNotice('')
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  event.stopPropagation()
                  void search()
                }}
              />
            </Field>
            {(query || lookup) && (
              <IconButton name="x" label={t('clearLookup')} data-testid="diagnostics-clear" onClick={clear} />
            )}
            <IconButton
              name="refresh-cw"
              label={t('refresh')}
              data-testid="diagnostics-refresh"
              disabled={busy}
              onClick={() => setReads((value) => value + 1)}
            />
          </span>
        }
      >
        <SettingsBlock
          bare
          data-testid="diagnostics-errors"
          className="agnes-diagnostics-errors"
          aria-busy={busy}
          state={error ? undefined : busy && !bundle ? 'loading' : undefined}
        >
          {(error || bundle) && (
            <RecentErrors
              records={bundle?.errors ?? []}
              lookup={lookup}
              limit={bundle?.limits.errors ?? 0}
              failure={error ? (appServerErrorMessage(failure, locale) ?? t('readFailedHelp')) : undefined}
              notice={notice}
              onRetryCopy={() => copyRetry.current()}
              onRetry={() => setReads((value) => value + 1)}
              onClear={clear}
              copy={copy}
            />
          )}
        </SettingsBlock>
      </SettingsDrill>
      <SettingsBlock label={t('integrations')} data-testid="diagnostics-runtime">
        <ObservabilityPanel />
        {integrations}
      </SettingsBlock>
      <Dialog
        open={exporting}
        size="sm"
        title={t('exportContents')}
        getContainer={() => document.body}
        onCancel={() => setExporting(false)}
        footer={
          <>
            <Button onClick={() => setExporting(false)}>{t('close')}</Button>
            <Button
              appearance="primary"
              data-testid="diagnostics-export-confirm"
              loading={busy}
              onClick={() =>
                void run(async (request) => {
                  const value = await api.export(selected ? { diagnosticId: selected } : {}, request.signal)
                  if (request.isCurrent()) {
                    download(value)
                    setExporting(false)
                    reportSuccess('diagnostics', t('exported'))
                  }
                })
              }
            >
              {t('export')}
            </Button>
          </>
        }
      >
        <div data-testid="diagnostics-export-details" className="agnes-diagnostics-export-grid">
          <p>{t('exportIncludes')}</p>
          <p>{t('exportExcludes')}</p>
          <p className="agnes-diagnostics-export-note">{t('exportSelection')}</p>
        </div>
      </Dialog>
    </>
  )
}
