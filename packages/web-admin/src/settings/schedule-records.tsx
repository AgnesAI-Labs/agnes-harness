import type {
  ScheduleHistoryEntry,
  SchedulesHistoryParams,
  SchedulesHistoryResult,
  SchedulesReceiptParams,
} from '@agnes/protocol'
import {
  Button,
  EmptyState,
  Icon,
  ListRow,
  MetaText,
  Segmented,
  SettingsDetails,
  SettingsList,
  StatusMessage,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { captureRequest, useRequestScope } from './async-request.js'
import { AUTOMATION_NAMESPACE, automationCatalog } from './automation-locale.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import { describeSchedule, moment, reasonText, runDuration, type Text } from './schedule-text.js'

export type ScheduleRecordsApi = {
  history?(query: SchedulesHistoryParams): Promise<SchedulesHistoryResult>
  receipt?(query: SchedulesReceiptParams): Promise<{ updated: boolean }>
}

/** History and the result inbox read the same persisted receipts; neither changes approval state. */
export function ScheduleRecords({
  api,
  id,
  refreshKey,
}: {
  api: ScheduleRecordsApi
  id?: string
  refreshKey?: unknown
}) {
  const { t: ux } = useUiText(AUTOMATION_NAMESPACE, automationCatalog)
  const [unread, setUnread] = useState(false)
  const [rows, setRows] = useState<ScheduleHistoryEntry[]>([])
  const [cursor, setCursor] = useState<string>()
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<string>()
  const [invalidCursor, setInvalidCursor] = useState(false)
  const lifetime = useRequestScope(api, `${id ?? 'results'}:${unread}`)
  const generation = useRef(0)
  const previousRefresh = useRef(refreshKey)
  const browsingOlder = useRef(false)
  const mutating = useRef(false)
  const deferredRefresh = useRef(false)
  const read = useCallback(
    async (before?: string, preserveError = false) => {
      if (!api.history || mutating.current) return
      const request = captureRequest(lifetime)
      const epoch = ++generation.current
      setLoading(true)
      if (!preserveError) setError(false)
      try {
        const value = await api.history({
          ...(id ? { id } : { resultsOnly: true }),
          ...(unread ? { unreadOnly: true } : {}),
          ...(before ? { before } : {}),
          limit: 20,
        })
        if (!request.isCurrent() || epoch !== generation.current) return
        setInvalidCursor(value.cursorInvalid === true)
        if (!value.cursorInvalid) {
          setRows((current) =>
            before
              ? [...current, ...value.runs.filter((run) => !current.some((saved) => saved.id === run.id))]
              : value.runs,
          )
          setCursor(value.nextCursor)
        }
      } catch {
        if (request.isCurrent() && epoch === generation.current) setError(true)
      } finally {
        if (request.isCurrent() && epoch === generation.current) setLoading(false)
      }
    },
    [api, id, unread, lifetime],
  )
  const refreshLatest = useCallback(() => {
    if (browsingOlder.current) return
    if (mutating.current) deferredRefresh.current = true
    else void read()
  }, [read])
  useEffect(() => {
    browsingOlder.current = false
    mutating.current = false
    deferredRefresh.current = false
    setRows([])
    setCursor(undefined)
    setPending(undefined)
    setInvalidCursor(false)
    void read()
  }, [read])
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'hidden') refreshLatest()
    }
    window.addEventListener('focus', wake)
    window.addEventListener('online', wake)
    return () => {
      window.removeEventListener('focus', wake)
      window.removeEventListener('online', wake)
    }
  }, [refreshLatest])
  // An updated task list already has a completion/due-time wake; reuse it instead of another timer.
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey !== previousRefresh.current) {
      previousRefresh.current = refreshKey
      refreshLatest()
    }
  }, [refreshKey, refreshLatest])
  const mark = async (run: ScheduleHistoryEntry) => {
    if (!api.receipt || mutating.current) return
    const request = captureRequest(lifetime)
    const nextRead = !run.read
    let failed = false
    mutating.current = true
    setPending(run.id)
    setError(false)
    try {
      const value = await api.receipt({ id: run.scheduleId, runId: run.id, read: nextRead })
      if (!request.isCurrent()) return
      if (!value.updated) throw new Error('receipt unavailable')
      generation.current++
      setRows((current) =>
        current.flatMap((saved) =>
          saved.id !== run.id ? [saved] : unread ? [] : [{ ...saved, read: nextRead }],
        ),
      )
    } catch {
      failed = true
      if (request.isCurrent()) setError(true)
    } finally {
      if (request.isCurrent()) {
        mutating.current = false
        setPending(undefined)
        if (deferredRefresh.current) {
          deferredRefresh.current = false
          if (!browsingOlder.current) void read(undefined, failed)
        }
      }
    }
  }
  return (
    <section data-testid={id ? 'schedule-history-page' : 'schedule-results'}>
      {!id && (
        <Segmented
          label={ux('resultFilter')}
          value={unread ? 'unread' : 'all'}
          onChange={(value) => setUnread(value === 'unread')}
          options={[
            { value: 'all', label: ux('allResults'), testId: 'schedule-results-all' },
            { value: 'unread', label: ux('unreadResults'), testId: 'schedule-results-unread' },
          ]}
        />
      )}
      <MetaText>{ux('historyRetained')}</MetaText>
      <Button
        size="small"
        data-testid="schedule-records-refresh"
        disabled={loading || !!pending}
        onClick={() => {
          browsingOlder.current = false
          void read()
        }}
      >
        {ux('refreshRecords')}
      </Button>
      {(error || invalidCursor) && (
        <StatusMessage kind="error" data-testid="schedule-records-error">
          {ux(invalidCursor ? 'historyCursorInvalid' : 'historyError')}
        </StatusMessage>
      )}
      {loading && <StatusMessage kind="pending">{ux('historyLoading')}</StatusMessage>}
      {!loading && !error && !invalidCursor && !rows.length && !cursor && (
        <EmptyState icon={<Icon name="clock" size={20} />} title={ux('recordsEmpty')} />
      )}
      <SettingsList>
        {rows.map((run) => (
          <RunReceipt
            key={run.id}
            run={run}
            canMark={!!api.receipt}
            disabled={!!pending || loading}
            onMark={() => void mark(run)}
            ux={ux}
          />
        ))}
      </SettingsList>
      {cursor && !invalidCursor && (
        <Button
          data-testid="schedule-records-more"
          disabled={loading || !!pending}
          onClick={() => {
            browsingOlder.current = true
            void read(cursor)
          }}
        >
          {ux('loadEarlier')}
        </Button>
      )}
    </section>
  )
}

export function ScheduleHistory({
  api,
  id,
  refreshKey,
}: {
  api: ScheduleRecordsApi
  id: string
  refreshKey?: unknown
}) {
  const [open, setOpen] = useState(false)
  const { t } = useUiText(AUTOMATION_NAMESPACE, automationCatalog)
  return (
    <>
      <Button
        size="small"
        data-testid="schedule-history-open"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {t('viewHistory')}
      </Button>
      {open && <ScheduleRecords api={api} id={id} refreshKey={refreshKey} />}
    </>
  )
}

function RunReceipt({
  run,
  canMark,
  disabled,
  onMark,
  ux,
}: {
  run: ScheduleHistoryEntry
  canMark: boolean
  disabled: boolean
  onMark(): void
  ux: Text
}) {
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const duration = runDuration(run, ux)
  return (
    <ListRow
      title={run.title}
      data-testid="schedule-record"
      data-unread={!run.read}
      status={
        <>
          <Tag tone={run.outcome === 'failed' ? 'bad' : 'info'}>{ux(`outcome.${run.outcome}`)}</Tag>
          {!run.read && <Tag tone="warn">{ux('unreadResult')}</Tag>}
        </>
      }
      description={
        <>
          {moment(run.at)}
          {duration && <> · {duration}</>}
        </>
      }
      actions={
        canMark &&
        ['ran', 'failed', 'delivered'].includes(run.outcome) && (
          <Button size="small" data-testid="schedule-record-mark" disabled={disabled} onClick={onMark}>
            {ux(run.read ? 'markUnread' : 'markRead')}
          </Button>
        )
      }
    >
      <p data-testid="schedule-record-summary">
        {run.summary ?? reasonText(run.reason, ux) ?? run.detail ?? ux('summaryUnavailable')}
      </p>
      {run.reason && run.summary && (
        <MetaText>{reasonText(run.reason, ux) ?? run.detail ?? run.reason}</MetaText>
      )}
      {run.sessionKey && (
        <a data-testid="schedule-record-session" href={`/?session=${encodeURIComponent(run.sessionKey)}`}>
          {ux('openFullResult')}
        </a>
      )}
      <SettingsDetails compact title={ux('runInstructions')}>
        {run.snapshot ? (
          <>
            <p data-testid="schedule-record-prompt">{run.snapshot.prompt}</p>
            <MetaText>{describeSchedule(run.snapshot.selector, t, ux)}</MetaText>
            <MetaText>
              {run.snapshot.target.kind === 'new-session'
                ? run.snapshot.target.cwd
                : run.snapshot.target.sessionKey}
            </MetaText>
            {run.snapshot.target.kind === 'new-session' && (
              <MetaText>
                {[
                  run.snapshot.target.preset,
                  run.snapshot.target.model?.route,
                  run.snapshot.target.model?.model,
                  run.snapshot.target.loop?.id,
                  ...(run.snapshot.target.bundles ?? []),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </MetaText>
            )}
          </>
        ) : (
          <MetaText>{ux('snapshotUnavailable')}</MetaText>
        )}
      </SettingsDetails>
    </ListRow>
  )
}
