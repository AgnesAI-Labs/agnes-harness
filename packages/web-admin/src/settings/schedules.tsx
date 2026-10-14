import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Menu,
  MetaText,
  Segmented,
  SettingsDetails,
  SettingsList,
  SettingsPageActions,
  SettingsPageDescription,
  SettingsSection,
  SettingsState,
  SettingsToolbar,
  StateSwitch,
  StatusDot,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AUTOMATION_NAMESPACE, automationCatalog } from './automation-locale.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import { useSettingsOverlay } from './overlay.js'
import {
  draftOf,
  emptyDraft,
  ScheduleDialog,
  type ScheduleDraft,
  selectorOf,
  targetOf,
} from './schedule-form.js'
import {
  folderName,
  rowsOf,
  type ScheduleChoices,
  type ScheduleRow,
  type ScheduleRun,
  type SessionInfo,
  sessionsOf,
  type Workspace,
  workspacesOf,
} from './schedule-model.js'
import {
  codeOf,
  describeSchedule,
  moment,
  reasonText,
  runDuration,
  type Text,
  when,
} from './schedule-text.js'

export { describeSchedule, localTimeZone } from './schedule-text.js'

export type SchedulesApi = {
  list(params: { scope: 'session' | 'all'; sessionKey?: string; includeArchived?: boolean }): Promise<unknown>
  upsert(params: unknown): Promise<unknown>
  archive(params: { id: string }): Promise<unknown>
  /** Run now, pause or resume; absent on a daemon without `schedules.control`. */
  control?(params: { id: string; action: 'run' | 'pause' | 'resume' }): Promise<unknown>
  /** The session the user came from: the default for a session target and for the workspace. */
  sessionKey(): string | undefined
  /** `workspace.list` and `session.list` results, read once when the page opens. */
  workspaces?(): Promise<unknown>
  sessions?(): Promise<unknown>
  /** Execution modes, presets and models a new session may use; empty when admin reads are not allowed. */
  choices?(): Promise<ScheduleChoices>
}

type Filter = 'all' | 'new-session' | 'session'
const NO_CHOICES: ScheduleChoices = { modes: [], presets: [], models: [] }

/** The session a run happened in, opened in the workbench. */
const sessionHref = (key: string) => `/?session=${encodeURIComponent(key)}`

/** Exceptions are tags; a run that went through is a quiet dot and a word. */
function OutcomeTag({ run, ux }: { run: ScheduleRun; ux: Text }) {
  const label = ux(`outcome.${run.outcome}`)
  if (run.outcome === 'failed' || run.outcome === 'waiting_approval')
    return (
      <Tag
        tone={run.outcome === 'failed' ? 'bad' : 'warn'}
        data-testid="schedules-outcome"
        data-outcome={run.outcome}
      >
        {label}
      </Tag>
    )
  return (
    <span className="automation-status" data-testid="schedules-outcome" data-outcome={run.outcome}>
      <StatusDot tone={run.outcome === 'running' ? 'accent' : 'success'} />
      {label}
    </span>
  )
}

function RunHistory({ runs, ux }: { runs: readonly ScheduleRun[]; ux: Text }) {
  return (
    <SettingsDetails
      compact
      title={ux('historyCount', { count: runs.length })}
      data-testid="schedules-history"
    >
      <ul className="automation-history">
        {[...runs].reverse().map((run) => {
          const took = runDuration(run, ux)
          const reason = run.outcome === 'failed' ? (reasonText(run.reason, ux) ?? run.detail) : undefined
          return (
            <li
              key={`${run.at}:${run.sessionKey ?? ''}:${run.outcome}`}
              data-testid="schedules-delivery"
              data-outcome={run.outcome}
              data-failed={run.outcome === 'failed' ? true : undefined}
            >
              <Icon name={run.outcome === 'failed' ? 'x' : 'check'} size={16} />
              {moment(run.at)}
              <OutcomeTag run={run} ux={ux} />
              {took && <MetaText>{took}</MetaText>}
              {reason && <MetaText>{reason}</MetaText>}
              {run.sessionKey && (
                <a data-testid="schedules-run-session" href={sessionHref(run.sessionKey)}>
                  {run.outcome === 'waiting_approval' ? ux('approve') : ux('openRunSession')}
                </a>
              )}
            </li>
          )
        })}
      </ul>
    </SettingsDetails>
  )
}

/** A one-line read of a code-bearing failure; the generic sentence when there is no known code. */
function failureText(error: unknown, ux: Text, t: Text): string {
  return reasonText(codeOf(error), ux) ?? t('schedulesError')
}

export function SchedulesPage({
  api,
  t,
  actionsHost,
}: {
  api?: SchedulesApi | undefined
  t(key: string): string
  /**
   * Where the page that hosts this list wants its primary action. Without one, the action and the
   * one-line description go to the enclosing settings page header.
   */
  actionsHost?: HTMLElement | null | undefined
}) {
  const { t: ux } = useUiText(AUTOMATION_NAMESPACE, automationCatalog)
  const alive = useRef(true)
  const epoch = useRef(0)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [error, setError] = useState<unknown>()
  const [formError, setFormError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [choices, setChoices] = useState<ScheduleChoices>(NO_CHOICES)
  const sessionKey = api?.sessionKey()
  const [draft, setDraft] = useState<ScheduleDraft>(() => emptyDraft({ sessionKey, now: Date.now() }))
  useSettingsOverlay(formOpen || !!pending)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      epoch.current++
    }
  }, [])
  // Names for targets: workspace and session titles, and what a new session may be started with.
  useEffect(() => {
    if (!api) return
    void api
      .workspaces?.()
      .then((value) => alive.current && setWorkspaces(workspacesOf(value)))
      .catch(() => undefined)
    void api
      .sessions?.()
      .then((value) => alive.current && setSessions(sessionsOf(value).filter((session) => !session.archived)))
      .catch(() => undefined)
    void api
      .choices?.()
      .then((value) => alive.current && setChoices(value))
      .catch(() => undefined)
  }, [api])
  const refresh = useCallback(() => {
    if (!api) return Promise.resolve()
    const request = ++epoch.current
    setLoading(true)
    return api
      .list({ scope: 'all', includeArchived })
      .then((value) => {
        if (!alive.current || request !== epoch.current) return
        setRows(rowsOf(value))
        setError(undefined)
      })
      .catch((reason: unknown) => {
        if (alive.current && request === epoch.current) setError(reason)
      })
      .finally(() => {
        if (alive.current && request === epoch.current) setLoading(false)
      })
  }, [api, includeArchived])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const sessionTitle = useMemo(() => new Map(sessions.map((item) => [item.id, item])), [sessions])
  const workspaceName = useMemo(() => new Map(workspaces.map((item) => [item.path, item.name])), [workspaces])
  const homeWorkspace = () => {
    const from = sessionKey ? sessionTitle.get(sessionKey)?.cwd : undefined
    return from || workspaces.find((item) => item.available)?.path || ''
  }
  const visible = rows.filter((row) => filter === 'all' || row.target.kind === filter)
  const save = async () => {
    if (!api || busy) return
    setFormError(undefined)
    setBusy(true)
    try {
      const result = (await api.upsert({
        ...(editing ? { id: editing } : {}),
        title: draft.title.trim(),
        prompt: draft.prompt.trim(),
        selector: selectorOf(draft),
        target: targetOf(draft, choices),
      })) as { id?: string; code?: string; updated?: boolean }
      if (!alive.current) return
      if (result.updated === false) {
        setFormError(failureText(result, ux, t))
        return
      }
      setNotice(t(editing ? 'schedulesSaved' : 'schedulesCreated'))
      setEditing(undefined)
      setFormOpen(false)
    } catch (reason) {
      if (alive.current) setFormError(failureText(reason, ux, t))
      return
    } finally {
      if (alive.current) setBusy(false)
    }
    // The list reloads on its own; the page stays usable meanwhile.
    void refresh()
  }
  const control = async (row: ScheduleRow, action: 'run' | 'pause' | 'resume') => {
    if (!api?.control || busy) return
    setError(undefined)
    setBusy(true)
    try {
      const result = (await api.control({ id: row.id, action })) as { updated?: boolean; code?: string }
      if (!alive.current) return
      if (result.updated === false) {
        setNotice(undefined)
        setError({ code: result.code })
        return
      }
      setNotice(ux(action === 'run' ? 'runStarted' : action === 'pause' ? 'noticePaused' : 'noticeResumed'))
    } catch (reason) {
      if (alive.current) setError(reason)
      return
    } finally {
      if (alive.current) setBusy(false)
    }
    void refresh()
  }
  const openNew = () => {
    setEditing(undefined)
    setFormError(undefined)
    setDraft(emptyDraft({ sessionKey, cwd: homeWorkspace(), now: Date.now() }))
    setFormOpen(true)
  }
  const openEdit = (row: ScheduleRow) => {
    setEditing(row.id)
    setFormError(undefined)
    const next = draftOf(row, choices, Date.now())
    setDraft({ ...next, sessionKey: next.sessionKey || sessionKey || '', cwd: next.cwd || homeWorkspace() })
    setFormOpen(true)
  }
  const create = (
    <Button
      appearance="primary"
      icon={<Icon name="plus" size={16} />}
      data-testid="schedules-new"
      disabled={!api || busy}
      onClick={openNew}
    >
      {ux('newSchedule')}
    </Button>
  )
  const targetText = (row: ScheduleRow) => {
    const target = row.target
    if (target.kind === 'new-session')
      return ux('targetNewRow', { workspace: workspaceName.get(target.cwd) || folderName(target.cwd) })
    return ux('targetSessionRow', {
      title: sessionTitle.get(target.sessionKey)?.title || ux('sessionUntitled'),
    })
  }
  return (
    <section data-testid="schedules-page" className="automation-panel">
      {actionsHost === undefined ? (
        <>
          <SettingsPageActions>{create}</SettingsPageActions>
          <SettingsPageDescription>{ux('schedulesIntro')}</SettingsPageDescription>
        </>
      ) : (
        actionsHost && createPortal(create, actionsHost)
      )}
      {loading && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {!api && (
        <SettingsState tone="error" data-testid="schedules-error">
          {t('schedulesUnavailable')}
        </SettingsState>
      )}
      <div className="agnes-settings-filters">
        <Segmented<Filter>
          label={ux('filterLabel')}
          testId="schedules-scope"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: ux('filterAll'), testId: 'schedules-scope-all' },
            { value: 'new-session', label: ux('filterNew'), testId: 'schedules-scope-new-session' },
            { value: 'session', label: ux('filterSession'), testId: 'schedules-scope-session' },
          ]}
        />
        <label className="agnes-settings-checkbox" htmlFor="schedules-include-archived">
          <StateSwitch
            id="schedules-include-archived"
            testId="schedules-include-archived"
            label={t('schedulesIncludeArchived')}
            disabled={false}
            checked={includeArchived}
            onToggle={setIncludeArchived}
          />
          {t('schedulesIncludeArchived')}
        </label>
      </div>
      <ScheduleDialog
        open={formOpen}
        editing={!!editing}
        draft={draft}
        onDraft={setDraft}
        choices={choices}
        workspaces={workspaces}
        sessions={sessions}
        busy={busy}
        error={formError}
        t={t}
        ux={ux}
        onCancel={() => setFormOpen(false)}
        onSubmit={() => void save()}
      />
      {notice && (
        <SettingsState tone="success" data-testid="schedules-notice">
          {notice}
        </SettingsState>
      )}
      {error !== undefined && api && !pending && (
        <SettingsState tone="error" data-testid="schedules-error">
          {failureText(error, ux, t)}
        </SettingsState>
      )}
      {api && visible.length === 0 && !error && !loading && (
        <EmptyState
          data-testid="schedules-empty"
          icon={<Icon name="clock" size={48} />}
          title={t('schedulesEmpty')}
          description={t('schedulesHelp')}
        />
      )}
      {visible.length > 0 && (
        <SettingsList>
          {visible.map((row) => {
            const live = row.status === 'active' || row.status === 'paused'
            const last = row.runs.at(-1)
            const target = row.target
            const link = target.kind === 'session' ? target.sessionKey : undefined
            return (
              <ListRow
                key={row.id}
                data-testid="schedules-row"
                data-status={row.status}
                data-target={target.kind}
                icon={<Icon name="clock" size={16} />}
                title={row.title}
                {...(live ? { onOpen: () => openEdit(row) } : {})}
                description={
                  <>
                    {link ? (
                      <a data-testid="schedules-target-link" href={sessionHref(link)}>
                        {targetText(row)}
                      </a>
                    ) : (
                      <span data-testid="schedules-target-text">{targetText(row)}</span>
                    )}
                    {' · '}
                    {describeSchedule(row.selector, t, ux)}
                    {' · '}
                    <span data-testid="schedules-next">
                      {t('schedulesNext')}{' '}
                      {row.nextRunAt === null ? t('schedulesNone') : when(row.nextRunAt, ux)}
                    </span>
                  </>
                }
                status={
                  row.status === 'active' ? (
                    last ? (
                      <OutcomeTag run={last} ux={ux} />
                    ) : (
                      <span className="automation-status">
                        <StatusDot tone="success" />
                        {ux('noRuns')}
                      </span>
                    )
                  ) : (
                    <MetaText data-testid="schedules-status">{ux(`status.${row.status}`)}</MetaText>
                  )
                }
                actions={
                  live && (
                    <>
                      <StateSwitch
                        testId="schedules-enabled"
                        label={ux('enabledLabel', { title: row.title })}
                        disabled={busy || !api?.control}
                        checked={row.status === 'active'}
                        onToggle={(checked) => void control(row, checked ? 'resume' : 'pause')}
                      />
                      <Menu
                        label={ux('more', { title: row.title })}
                        trigger={
                          <IconButton
                            size="small"
                            appearance="ghost"
                            data-testid="schedules-actions"
                            name="ellipsis"
                            label={ux('more', { title: row.title })}
                          />
                        }
                        items={[
                          ...(api?.control && row.status === 'active'
                            ? [
                                {
                                  id: 'run',
                                  label: ux('runNow'),
                                  testId: 'schedules-run-now',
                                  disabled: busy || last?.outcome === 'running',
                                  onSelect: () => void control(row, 'run'),
                                },
                              ]
                            : []),
                          {
                            id: 'edit',
                            label: ux('edit'),
                            testId: 'schedules-edit',
                            onSelect: () => openEdit(row),
                          },
                          {
                            id: 'archive',
                            label: ux('archive'),
                            danger: true,
                            testId: 'schedules-archive',
                            ariaLabel: ux('archiveLabel', { title: row.title }),
                            onSelect: () => {
                              setError(undefined)
                              setPending(row.id)
                            },
                          },
                        ]}
                      />
                    </>
                  )
                }
              >
                {row.runs.length > 0 && <RunHistory runs={row.runs} ux={ux} />}
              </ListRow>
            )
          })}
        </SettingsList>
      )}
      <p className="automation-note">{ux('missedNote')}</p>
      <Dialog
        focusable={{ focusTriggerAfterClose: false }}
        scrollLock={false}
        getContainer={() => document.body}
        open={!!pending}
        title={t('schedulesConfirm')}
        footer={null}
        onCancel={() => {
          if (!busy) setPending(undefined)
        }}
      >
        <p>{t('schedulesConfirmBody')}</p>
        {pending && error !== undefined && <SettingsState tone="error">{t('schedulesError')}</SettingsState>}
        <SettingsToolbar>
          <Button
            htmlType="button"
            data-testid="schedules-archive-cancel"
            disabled={busy}
            onClick={() => setPending(undefined)}
          >
            {t('schedulesCancel')}
          </Button>
          <Button
            htmlType="button"
            danger
            dangerFilled
            data-testid="schedules-archive-confirm"
            disabled={busy}
            loading={busy}
            onClick={() => {
              const id = pending
              if (!api || !id || busy) return
              setError(undefined)
              setBusy(true)
              void api
                .archive({ id })
                .then((result) => {
                  if (!alive.current) return
                  if ((result as { deleted?: boolean }).deleted === false) throw new Error('archive refused')
                  setNotice(t('schedulesArchived'))
                  setPending(undefined)
                  return refresh()
                })
                .catch((reason: unknown) => {
                  if (alive.current) setError(reason)
                })
                .finally(() => {
                  if (alive.current) setBusy(false)
                })
            }}
          >
            {t('schedulesConfirm')}
          </Button>
        </SettingsToolbar>
      </Dialog>
    </section>
  )
}

/**
 * The session runtime dialog's short list: tasks this session receives or created, with a link to the
 * automation page where they are managed. Hidden until the daemon answers, and when it cannot.
 */
export function SessionSchedules({
  list,
  sessionKey,
  onManage,
}: {
  list(params: { scope: 'session'; sessionKey: string }): Promise<unknown>
  sessionKey: string
  onManage(): void
}) {
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const { t: ux } = useUiText(AUTOMATION_NAMESPACE, automationCatalog)
  const [rows, setRows] = useState<ScheduleRow[]>()
  useEffect(() => {
    let current = true
    setRows(undefined)
    void list({ scope: 'session', sessionKey })
      .then((value) => current && setRows(rowsOf(value)))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [list, sessionKey])
  if (!rows) return null
  return (
    <SettingsSection
      title={ux('sessionReminders')}
      data-testid="session-schedules"
      actions={
        <Button appearance="ghost" size="small" data-testid="session-schedules-manage" onClick={onManage}>
          {ux('manageAutomation')}
        </Button>
      }
    >
      {rows.length === 0 ? (
        <SettingsState>{ux('sessionRemindersNone')}</SettingsState>
      ) : (
        <SettingsList>
          {rows.map((row) => (
            <ListRow
              key={row.id}
              data-testid="session-schedules-row"
              icon={<Icon name="clock" size={16} />}
              title={row.title}
              description={`${describeSchedule(row.selector, t, ux)}${
                row.nextRunAt === null ? '' : ` · ${t('schedulesNext')} ${when(row.nextRunAt, ux)}`
              }`}
              status={row.status === 'active' ? undefined : <MetaText>{ux(`status.${row.status}`)}</MetaText>}
            />
          ))}
        </SettingsList>
      )}
    </SettingsSection>
  )
}
