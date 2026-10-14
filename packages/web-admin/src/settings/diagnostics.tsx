import { type DiagnosticRecord, type DiagnosticsExportResult, errorMessageKey } from '@agnes/protocol'
import type { DoctorResult } from '@agnes/protocol/gen/app-server'
import {
  appServerErrorMessage,
  Banner,
  Button,
  Dialog,
  FIRST_RUN_NAMESPACE,
  firstRunCatalog,
  Segmented,
  SettingsBlock,
  SettingsDrill,
  SettingsExpand,
  SettingsInput,
  SettingsItem,
  SettingsPageActions,
  SettingsState,
  useUiText,
} from '@agnes/web-ui'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  type DiagnosticsApi,
  DiagnosticsRequestError,
  diagnosticsApi,
  downloadDiagnostics,
} from './diagnostics-api.js'
import { DIAGNOSTICS_NAMESPACE, diagnosticsCatalog } from './diagnostics-locale.js'
import { DoctorRows } from './doctor.js'
import { ObservabilityPanel } from './observability.js'
import { useSettingsOverlay } from './overlay.js'

const browserApi = diagnosticsApi()
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
/** How many grouped errors the page shows before 「查看全部」. */
const RECENT = 4
type Filter = 'all' | 'permission' | 'provider' | 'plugin'

/** Repeats of the same error (same name, cause and code) are one row that counts them. */
export function groupErrors(records: readonly DiagnosticRecord[]) {
  const groups = new Map<string, { latest: DiagnosticRecord; count: number }>()
  for (const record of [...records].reverse()) {
    const key = `${record.name}\u0000${record.cause ?? ''}\u0000${record.code}`
    const known = groups.get(key)
    if (known) known.count += 1
    else groups.set(key, { latest: record, count: 1 })
  }
  return [...groups.values()]
}

/** A coarse kind for the filter, read from the error's name and cause. */
export function errorKind(record: DiagnosticRecord): Filter {
  const text = `${record.name} ${record.cause ?? ''}`.toLowerCase()
  if (/permission|capab|policy|forbidden|approval|denied/.test(text)) return 'permission'
  if (/provider|model|account|credential|rate|upstream/.test(text)) return 'provider'
  if (/plugin|package|extension|skill|mcp/.test(text)) return 'plugin'
  return 'all'
}

/**
 * 运行时与诊断: status checks as rows with a state mark (重新检查, 测试模型账户), recent errors one line
 * each with repeats grouped (open one for its details and copy; 「查看全部」 is a subpage with a
 * filter), and 集成 (OTLP export and the runtime details as subpages). The page header copies a
 * summary and exports a redacted bundle after saying what it contains.
 */
export function DiagnosticsPanel({
  api = browserApi,
  download = downloadDiagnostics,
  integrations,
}: {
  api?: DiagnosticsApi
  download?: (bundle: DiagnosticsExportResult) => void
  /** More rows of 集成 (the runtime details), given by the page. */
  integrations?: ReactNode
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
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState('')
  const [reads, setReads] = useState(0)
  const alive = useRef(false)
  const controller = useRef<AbortController>()
  useSettingsOverlay(exporting)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reads is an explicit retry.
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
  }, [api, reads])
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
  const time = (at: string) =>
    new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(at))
  const copy = (value: string, done: string) =>
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => {
          if (alive.current) setNotice(done)
        },
        () => {
          if (alive.current) setNotice('copyFailed')
        },
      )
  const failure = error instanceof DiagnosticsRequestError ? error.envelope : undefined
  const boundSessions = bundle?.generations.available
    ? bundle.generations.items.reduce((count, row) => count + row.boundSessions, 0)
    : undefined
  const workerStatus = bundle?.doctor.find((row) => row.name === 'worker')?.status
  const workerIdle = boundSessions === 0 && (!workerStatus || workerStatus === 'unavailable')
  const groups = groupErrors(bundle?.errors ?? [])
  const count = new Intl.NumberFormat(locale).format(bundle?.errors.length ?? 0)
  const errorRow = (group: ReturnType<typeof groupErrors>[number], full = false) => {
    const record = group.latest
    return (
      <SettingsExpand
        key={record.diagnosticId}
        data-testid="diagnostics-error"
        className="agnes-settings-error-row"
        leading={
          <time dateTime={record.at} className="agnes-settings-time" data-testid="diagnostics-error-time">
            {time(record.at)}
          </time>
        }
        label={message(record)}
        hint={group.count > 1 ? t('repeats', { count: group.count }) : full ? record.diagnosticId : undefined}
        value={<code className="agnes-settings-code-chip">{record.code}</code>}
      >
        <SettingsBlock>
          <SettingsItem label={t('id')}>
            <code data-testid="diagnostics-error-id">{record.diagnosticId}</code>
          </SettingsItem>
          <SettingsItem label={t('code')}>
            <code data-testid="diagnostics-error-code">{record.code}</code>
          </SettingsItem>
          <SettingsItem label={t('name')}>
            <code>{record.name}</code>
          </SettingsItem>
          {record.cause && (
            <SettingsItem label={t('cause')}>
              <code>{record.cause}</code>
            </SettingsItem>
          )}
          {group.count > 1 && (
            <SettingsItem label={t('times')}>
              <span className="agnes-settings-value">{group.count}</span>
            </SettingsItem>
          )}
        </SettingsBlock>
        <div className="agnes-settings-toolbar-row">
          <Button
            size="small"
            data-testid="diagnostics-copy"
            onClick={() => copy(record.diagnosticId, 'copied')}
          >
            {t('copy')}
          </Button>
        </div>
      </SettingsExpand>
    )
  }
  const filtered = groups.filter((group) => {
    const needle = text.trim().toLowerCase()
    return (
      (filter === 'all' || errorKind(group.latest) === filter) &&
      (!needle ||
        `${group.latest.diagnosticId} ${message(group.latest)} ${group.latest.name} ${group.latest.code}`
          .toLowerCase()
          .includes(needle))
    )
  })
  return (
    <>
      <SettingsPageActions>
        <Button
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
          {t('copySummary')}
        </Button>
        <Button
          appearance="primary"
          data-testid="diagnostics-export"
          disabled={busy || !bundle}
          onClick={() => setExporting(true)}
        >
          {t('exportReviewAction')}
        </Button>
      </SettingsPageActions>
      {notice && (
        <SettingsState
          tone={notice === 'invalid' || notice === 'copyFailed' ? 'error' : 'success'}
          data-testid="diagnostics-notice"
        >
          {t(notice)}
        </SettingsState>
      )}
      <SettingsBlock label={t('doctor')} bare data-testid="diagnostics-checks">
        {doctorAvailable ? (
          <DoctorRows
            load={loadChecks}
            worker={workerIdle ? t('workerIdle') : t(`state.${workerStatus ?? 'unavailable'}`)}
            version={bundle ? `${bundle.agh.version} · Node ${bundle.runtime.node}` : undefined}
          />
        ) : (
          <SettingsBlock data-testid="diagnostics-worker-only">
            <SettingsItem label={t('worker')}>
              <span className="agnes-settings-value" data-testid="diagnostics-worker">
                {workerIdle ? t('workerIdle') : t(`state.${workerStatus ?? 'unavailable'}`)}
              </span>
            </SettingsItem>
          </SettingsBlock>
        )}
      </SettingsBlock>
      <SettingsBlock
        label={`${t('recent')} · ${count}`}
        data-testid="diagnostics-errors"
        aria-busy={busy}
        state={error ? undefined : busy && !bundle ? 'loading' : undefined}
        actions={
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
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              event.stopPropagation()
              void search()
            }}
          />
        }
      >
        {error ? (
          <SettingsItem
            label={appServerErrorMessage(failure, locale) ?? t('unavailable')}
            data-testid="diagnostics-failure"
          >
            <Button size="small" onClick={() => setReads((value) => value + 1)}>
              {t('retry')}
            </Button>
          </SettingsItem>
        ) : (
          bundle && (
            <>
              {groups.length === 0 && <SettingsItem label={t('empty')} />}
              {groups.slice(0, RECENT).map((group) => errorRow(group))}
              {groups.length > RECENT && (
                <SettingsDrill
                  id="errors"
                  data-testid="diagnostics-view-all"
                  label={t('viewAllCount', { count })}
                  title={t('allErrors')}
                  description={t('allErrorsHelp', { count })}
                >
                  <div className="agnes-settings-toolbar-row">
                    <SettingsInput
                      surface="surface"
                      data-testid="diagnostics-filter-text"
                      aria-label={t('filterText')}
                      placeholder={t('filterText')}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                    <Segmented<Filter>
                      label={t('filterKind')}
                      testId="diagnostics-filter-kind"
                      value={filter}
                      options={(['all', 'permission', 'provider', 'plugin'] as const).map((value) => ({
                        value,
                        label: t(`filter.${value}`),
                      }))}
                      onChange={setFilter}
                    />
                  </div>
                  <SettingsBlock data-testid="diagnostics-all-errors">
                    {filtered.length === 0 && <SettingsItem label={t('empty')} />}
                    {filtered.map((group) => errorRow(group, true))}
                  </SettingsBlock>
                </SettingsDrill>
              )}
            </>
          )
        )}
      </SettingsBlock>
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
                void run(async () => {
                  const value = await api.export(
                    selected ? { diagnosticId: selected } : {},
                    controller.current?.signal,
                  )
                  if (alive.current) {
                    download(value)
                    setExporting(false)
                    setNotice('exported')
                  }
                })
              }
            >
              {t('export')}
            </Button>
          </>
        }
      >
        <div data-testid="diagnostics-export-details">
          <p>{t('exportHelp')}</p>
          <Banner tone="warning">{t('exportReview')}</Banner>
        </div>
      </Dialog>
    </>
  )
}
