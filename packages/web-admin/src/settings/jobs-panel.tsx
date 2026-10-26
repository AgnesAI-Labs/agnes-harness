import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  ListRow,
  Menu,
  type SessionOption,
  SessionPicker,
  SettingsCode,
  SettingsDetails,
  SettingsPageDescription,
  SettingsState,
  SettingsToolbar,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { captureRequest, useRequestScope } from './async-request.js'
import { type JobsSessionSource, type JobsSnapshot, jobsSessions, sessionJobsApi } from './jobs-api.js'
import { JOBS_NAMESPACE, jobsCatalog } from './jobs-locales.js'
import { useSettingsOverlay } from './overlay.js'

const defaultApi = sessionJobsApi()
const defaultSessions = jobsSessions()
const SESSION_STORAGE_KEY = 'agnes.jobs.session'
export function JobsPanel({
  api = defaultApi,
  sessions = defaultSessions,
}: {
  api?: ReturnType<typeof sessionJobsApi>
  sessions?: JobsSessionSource
}) {
  const { t, locale } = useUiText(JOBS_NAMESPACE, jobsCatalog)
  const [choices, setChoices] = useState<SessionOption[]>()
  const [sessionId, setSessionId] = useState('')
  const [snapshot, setSnapshot] = useState<JobsSnapshot>()
  const [jobId, setJobId] = useState<string>()
  const [error, setError] = useState(false)
  const [sessionsError, setSessionsError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState<string>()
  const [updatedAt, setUpdatedAt] = useState<Date>()
  useSettingsOverlay(!!pending)
  const lifetime = useRequestScope(api, JSON.stringify([sessionId, jobId]))
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useEffect(() => {
    setBusy(false)
    setPending(undefined)
  }, [api, sessionId, jobId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry counter explicitly starts a fresh read.
  useEffect(() => {
    let active = true
    void sessions
      .list()
      .then(async (rows) => {
        if (!active) return
        const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        setChoices(sorted)
        setSessionsError(false)
        const current = sessions.current()
        const saved = localStorage.getItem(SESSION_STORAGE_KEY)
        let selected =
          sorted.find((row) => row.id === current)?.id ?? sorted.find((row) => row.id === saved)?.id
        if (!selected) {
          // A bounded recent scan favors sessions with actual work without loading every output.
          for (const row of sorted.slice(0, 7)) {
            try {
              if ((await api.read(row.id)).jobs.length) {
                selected = row.id
                break
              }
            } catch {
              /* Try the next recent session. */
            }
            if (!active) return
          }
        }
        if (active) setSessionId(selected ?? sorted[0]?.id ?? '')
        if (saved && !sorted.some((row) => row.id === saved)) localStorage.removeItem(SESSION_STORAGE_KEY)
      })
      .catch(() => {
        if (active) setSessionsError(true)
      })
    return () => {
      active = false
    }
  }, [sessions, api, revision])
  useEffect(() => {
    if (!sessionId) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let attempts = 0
    let hasRunning = false
    const visible = () => document.visibilityState !== 'hidden'
    async function refresh() {
      if (!active || inFlight || !visible()) return
      inFlight = true
      let running = hasRunning
      try {
        const value = await api.read(sessionId, jobId)
        if (!active) return
        running = value.jobs.some((job) => job.status === 'running')
        hasRunning = running
        setSnapshot(value)
        setError(false)
        setUpdatedAt(new Date())
      } catch {
        if (active) setError(true)
      } finally {
        inFlight = false
        if (active && running && visible())
          timer = setTimeout(() => void refresh(), Math.min(30_000, 1000 * 2 ** Math.min(5, attempts++)))
      }
    }
    const wake = () => {
      clearTimeout(timer)
      void refresh()
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('agnes:jobs-changed', wake)
    void refresh()
    return () => {
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('agnes:jobs-changed', wake)
      active = false
      clearTimeout(timer)
    }
  }, [sessionId, jobId, api])
  async function stop() {
    if (busy || !pending || !sessionId) return
    const request = captureRequest(lifetime)
    const scope = sessionId
    const id = pending
    if (!snapshot?.jobs.some((job) => job.id === id && job.owner === 'human' && job.status === 'running'))
      return
    setBusy(true)
    try {
      const result = await api.control(scope, { operation: 'kill', jobId: id })
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false)
        throw new Error('Stop refused')
      if (!request.isCurrent()) return
      setPending(undefined)
      const value = await api.read(scope, jobId)
      if (!request.isCurrent()) return
      setSnapshot(value)
      setError(false)
    } catch {
      if (request.isCurrent()) setError(true)
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
  }
  const sessionChoice = (
    <Field label={t('session')} htmlFor="jobs-session">
      <SessionPicker
        id="jobs-session"
        testId="jobs-session"
        sessions={choices ?? []}
        value={sessionId}
        onChange={(id) => {
          setSessionId(id)
          setSnapshot(undefined)
          setJobId(undefined)
          setPending(undefined)
          setError(false)
          localStorage.setItem(SESSION_STORAGE_KEY, id)
        }}
        label={t('session')}
        locale={locale}
        disabled={busy}
      />
    </Field>
  )
  const updatedLabel = updatedAt ? (
    <time dateTime={updatedAt.toISOString()}>
      {t('updated')} {new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(updatedAt)}
    </time>
  ) : undefined
  const currentSession = sessions.current() === sessionId
  return (
    <section data-testid="jobs-panel">
      <SettingsPageDescription>{t('jobsHelp')}</SettingsPageDescription>
      {sessionsError ? (
        <Banner
          tone="error"
          action={<Button onClick={() => setRevision((value) => value + 1)}>{t('retry')}</Button>}
        >
          {t('sessionsUnavailable')}
        </Banner>
      ) : !choices ? (
        <SettingsState tone="loading">{t('loading')}</SettingsState>
      ) : !choices.length ? (
        <EmptyState
          data-testid="jobs-no-sessions"
          icon={<Icon name="clock" size={48} />}
          title={t('noSessions')}
          description={t('chooseSession')}
          actions={
            <Button appearance="primary" href="/?new=1">
              {t('newSession')}
            </Button>
          }
        />
      ) : (
        <SettingsToolbar
          filters={
            currentSession ? (
              <SettingsDetails
                compact
                // The stamp rides in the title's own line box: the toolbar aligns its cells by their
                // bottom edge, which leaves the title and a smaller stamp off one baseline.
                title={
                  <>
                    {`${t('session')}: ${choices.find((row) => row.id === sessionId)?.title ?? ''}`}
                    {updatedLabel && <span className="jobs-session-updated">{updatedLabel}</span>}
                  </>
                }
                data-testid="jobs-session-context"
              >
                {sessionChoice}
              </SettingsDetails>
            ) : (
              sessionChoice
            )
          }
          controls={currentSession ? undefined : updatedLabel}
        />
      )}
      {error && (
        <Banner tone="error" data-testid="jobs-error">
          {t('unavailable')}
        </Banner>
      )}
      {sessionId && !snapshot && !error && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {snapshot && !snapshot.jobs.length && (
        <EmptyState icon={<Icon name="clock" size={48} />} title={t('empty')} description={t('emptyHelp')} />
      )}
      <section data-testid="session-jobs-table" aria-label={t('jobs')}>
        {snapshot?.jobs.map((job) => (
          <ListRow
            key={job.id}
            data-testid={'session-job-' + job.id}
            title={<code>{job.command}</code>}
            meta={[
              job.status === 'failed' ? '' : t(job.status),
              t(`jobKind.${job.kind}`),
              job.code === null ? '' : `${t('exitCode')} ${job.code}`,
            ]
              .filter(Boolean)
              .join(' · ')}
            status={job.status === 'failed' ? <Tag tone="bad">{t('failed')}</Tag> : undefined}
            actions={
              <>
                <Button disabled={busy} onClick={() => setJobId(job.id)}>
                  {t('output')}
                </Button>
                {job.status === 'running' && (
                  <Menu
                    label={t('actions')}
                    trigger={<IconButton name="ellipsis" label={t('actions')} />}
                    items={[
                      {
                        id: 'stop',
                        label: t('kill'),
                        danger: true,
                        disabled: busy || job.owner !== 'human',
                        disabledReason: t('agentOwnedControl'),
                        onSelect: () => setPending(job.id),
                      },
                    ]}
                  />
                )}
              </>
            }
          />
        ))}
      </section>
      {snapshot?.job && (
        <SettingsDetails open title={t('output')}>
          <SettingsCode label={t('output')} data-testid="job-output">
            {snapshot.job.stdout}
            {snapshot.job.stderr}
          </SettingsCode>
        </SettingsDetails>
      )}
      <div role="status" aria-live="polite" data-testid="job-completions">
        {snapshot?.completions.slice(-5).map((job) => (
          <p key={job.id}>
            {t('completedNotice')}: {job.command} · {t(job.status)}
          </p>
        ))}
      </div>
      <Dialog
        focusable={{ focusTriggerAfterClose: false }}
        scrollLock={false}
        getContainer={() => document.body}
        open={!!pending}
        title={t('confirmStop')}
        onCancel={() => {
          if (!busy) setPending(undefined)
        }}
        footer={
          <>
            <Button data-testid="jobs-stop-cancel" disabled={busy} onClick={() => setPending(undefined)}>
              {t('cancel')}
            </Button>
            <Button
              danger
              dangerFilled
              data-testid="jobs-stop-confirm"
              loading={busy}
              onClick={() => void stop()}
            >
              {t('kill')}
            </Button>
          </>
        }
      >
        <p>{t('confirmStopHelp')}</p>
        {error && <SettingsState tone="error">{t('unavailable')}</SettingsState>}
      </Dialog>
    </section>
  )
}
