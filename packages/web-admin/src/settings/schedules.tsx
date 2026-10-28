import {
  Button,
  ConfirmDialog,
  EmptyState,
  Icon,
  IconButton,
  invalidateResource,
  ListRow,
  Loadable,
  Menu,
  MetaText,
  reportSuccess,
  Segmented,
  SettingsDetails,
  SettingsList,
  SettingsPageActions,
  SettingsPageDescription,
  SettingsSection,
  SettingsState,
  StateSwitch,
  StatusDot,
  StatusMessage,
  setResource,
  Tag,
  usePushStack,
  useResource,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { captureRequest, useRequestScope } from './async-request.js'
import { AUTOMATION_NAMESPACE, automationCatalog } from './automation-locale.js'
import { SETTINGS_NAMESPACE, settingsCatalog } from './locales.js'
import { useSettingsOverlay } from './overlay.js'
import {
  draftOf,
  emptyDraft,
  type ScheduleDraft,
  ScheduleEditor,
  schedulePageId,
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
import { useScheduleRefresh } from './schedule-refresh.js'
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
  if (run.needsAttention || ['failed', 'waiting_approval', 'needs_attention'].includes(run.outcome))
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
          const reason =
            run.needsAttention ||
            run.outcome === 'failed' ||
            run.outcome === 'waiting_approval' ||
            run.outcome === 'needs_attention'
              ? (reasonText(run.reason, ux) ?? run.detail)
              : undefined
          return (
            <li
              key={`${run.at}:${run.sessionKey ?? ''}:${run.outcome}`}
              data-testid="schedules-delivery"
              data-outcome={run.outcome}
              data-failed={run.outcome === 'failed' ? true : undefined}
            >
              <Icon
                name={
                  run.outcome === 'failed'
                    ? 'x'
                    : ['waiting_approval', 'needs_attention'].includes(run.outcome)
                      ? 'clock'
                      : 'check'
                }
                size={16}
              />
              {moment(run.at)}
              <OutcomeTag run={run} ux={ux} />
              {(run.needsAttention || ['waiting_approval', 'needs_attention'].includes(run.outcome)) && (
                <MetaText>{ux('needsAttention')}</MetaText>
              )}
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

/** One cache entry per backend, so two pages reading different daemons never share a list. */
const apiKeys = new WeakMap<object, number>()
let apis = 0
function apiKey(api: object): number {
  let key = apiKeys.get(api)
  if (key === undefined) {
    key = ++apis
    apiKeys.set(api, key)
  }
  return key
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
  const [filter, setFilter] = useState<Filter>('all')
  const [includeArchived, setIncludeArchived] = useState(false)
  // The list is a cached read: shown at once when the page opens again, refreshed behind.
  const listKey = api ? `schedules:${apiKey(api)}:${includeArchived ? 'all' : 'live'}` : undefined
  const list = useResource(listKey, () => (api as SchedulesApi).list({ scope: 'all', includeArchived }), {
    revalidateOnFocus: false,
  })
  const rows = useMemo(() => (list.data === undefined ? [] : rowsOf(list.data)), [list.data])
  const loading = list.loading
  // Failures of an action the reader took; a failed read shows where the list is.
  const [error, setError] = useState<unknown>()
  const [formError, setFormError] = useState<string>()
  const setNotice = (message: string | undefined) => {
    if (message) reportSuccess('schedules', message)
  }
  const [runRequested, setRunRequested] = useState(false)
  const [pending, setPending] = useState<string>()
  const [busy, setBusy] = useState(false)
  // New and edit open as pages inside Automation: the open page is the address (`view=schedule-…`).
  const nav = usePushStack()
  const top = nav.stack.at(-1)
  const lifetime = useRequestScope(api, top)
  const formOpen = top?.startsWith('schedule-') === true
  const editing = formOpen && top !== schedulePageId(undefined) ? top.slice('schedule-'.length) : undefined
  /** The page whose draft the form holds; a link opened directly fills it once its row is known. */
  const prepared = useRef<string>()
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [choices, setChoices] = useState<ScheduleChoices>(NO_CHOICES)
  const sessionKey = api?.sessionKey()
  const [draft, setDraft] = useState<ScheduleDraft>(() => emptyDraft({ sessionKey, now: Date.now() }))
  useSettingsOverlay(formOpen || !!pending)
  // biome-ignore lint/correctness/useExhaustiveDependencies: each page or connection starts a fresh operation scope.
  useEffect(() => {
    setBusy(false)
    setError(undefined)
    setFormError(undefined)
  }, [api, top])
  // Names for targets: workspace and session titles, and what a new session may be started with.
  useEffect(() => {
    if (!api) return
    let current = true
    void api
      .workspaces?.()
      .then((value) => current && setWorkspaces(workspacesOf(value)))
      .catch(() => undefined)
    void api
      .sessions?.()
      .then((value) => current && setSessions(sessionsOf(value).filter((session) => !session.archived)))
      .catch(() => undefined)
    void api
      .choices?.()
      .then((value) => current && setChoices(value))
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [api])
  /**
   * After a write every cached schedule list reads again. A background re-read stays quiet: it
   * replaces the cached list without a loading state or the page progress bar.
   */
  const refresh = useCallback(
    (quiet = false) => {
      if (!api) return Promise.resolve()
      if (!quiet) {
        invalidateResource('schedules')
        return Promise.resolve()
      }
      const request = captureRequest(lifetime)
      return api
        .list({ scope: 'all', includeArchived })
        .then((value) => {
          if (request.isCurrent() && listKey) setResource(listKey, value)
        })
        .catch(() => undefined)
    },
    [api, includeArchived, listKey, lifetime],
  )
  const live = useScheduleRefresh(() => refresh(true), rows, Boolean(api))
  const sessionTitle = useMemo(() => new Map(sessions.map((item) => [item.id, item])), [sessions])
  const workspaceName = useMemo(() => new Map(workspaces.map((item) => [item.path, item.name])), [workspaces])
  const homeWorkspace = () => {
    const from = sessionKey ? sessionTitle.get(sessionKey)?.cwd : undefined
    return from || workspaces.find((item) => item.available)?.path || ''
  }
  const visible = rows.filter((row) => filter === 'all' || row.target.kind === filter)
  const save = async () => {
    if (!api || busy) return
    const request = captureRequest(lifetime)
    setFormError(undefined)
    setBusy(true)
    try {
      const result = (await api.upsert({
        ...(editing ? { id: editing } : {}),
        title: draft.title.trim(),
        prompt: draft.prompt.trim(),
        selector: selectorOf(draft),
        target: targetOf(draft, choices),
        ...((!draft.saved || draft.mode !== draft.saved.mode) &&
        choices.modes.find((mode) => mode.key === draft.mode)?.businessAgent
          ? { agent: draft.mode }
          : {}),
      })) as { id?: string; code?: string; updated?: boolean }
      if (!request.isCurrent()) return
      if (result.updated === false) {
        setFormError(failureText(result, ux, t))
        return
      }
      setNotice(t(editing ? 'schedulesSaved' : 'schedulesCreated'))
      nav.back()
    } catch (reason) {
      if (request.isCurrent()) setFormError(failureText(reason, ux, t))
      return
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
    // The list reloads on its own; the page stays usable meanwhile.
    void refresh()
  }
  const control = async (row: ScheduleRow, action: 'run' | 'pause' | 'resume') => {
    if (!api?.control || busy) return
    const request = captureRequest(lifetime)
    setError(undefined)
    setBusy(true)
    try {
      const result = (await api.control({ id: row.id, action })) as { updated?: boolean; code?: string }
      if (!request.isCurrent()) return
      if (result.updated === false) {
        setNotice(undefined)
        setError({ code: result.code })
        return
      }
      if (action === 'run') {
        live.expectRun()
        setRunRequested(true)
      } else setNotice(ux(action === 'pause' ? 'noticePaused' : 'noticeResumed'))
    } catch (reason) {
      if (request.isCurrent()) setError(reason)
      return
    } finally {
      if (request.isCurrent()) setBusy(false)
    }
    void refresh()
  }
  const prepareNew = () => {
    prepared.current = schedulePageId(undefined)
    setFormError(undefined)
    setDraft(emptyDraft({ sessionKey, cwd: homeWorkspace(), now: Date.now() }))
  }
  const prepareEdit = (row: ScheduleRow) => {
    prepared.current = schedulePageId(row.id)
    setFormError(undefined)
    const next = draftOf(row, choices, Date.now())
    setDraft({ ...next, sessionKey: next.sessionKey || sessionKey || '', cwd: next.cwd || homeWorkspace() })
  }
  const openNew = () => {
    prepareNew()
    nav.open(schedulePageId(undefined))
  }
  const openEdit = (row: ScheduleRow) => {
    prepareEdit(row)
    nav.open(schedulePageId(row.id))
  }
  // A link (or a reload) that names the form opens it here: a new task at once, a task once its row is read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the form is prepared once per opened page.
  useEffect(() => {
    if (!formOpen || !top) {
      prepared.current = undefined
      return
    }
    if (prepared.current === top) return
    if (top === schedulePageId(undefined)) return prepareNew()
    const row = rows.find((item) => schedulePageId(item.id) === top)
    if (row) prepareEdit(row)
  }, [formOpen, top, rows])
  // A form opened before the workspaces were read gets the default workspace once they are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fills one empty field once the list arrives.
  useEffect(() => {
    if (!formOpen || editing || draft.cwd) return
    const cwd = homeWorkspace()
    if (cwd) setDraft((current) => (current.cwd ? current : { ...current, cwd }))
  }, [formOpen, editing, workspaces, sessions])
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
      {!api && (
        <SettingsState tone="error" data-testid="schedules-error">
          {t('schedulesUnavailable')}
        </SettingsState>
      )}
      <div className="automation-toolbar" data-testid="schedules-toolbar">
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
        <label
          className="agnes-settings-checkbox automation-toolbar-switch"
          htmlFor="schedules-include-archived"
        >
          <StateSwitch
            id="schedules-include-archived"
            testId="schedules-include-archived"
            label={t('schedulesIncludeArchived')}
            disabled={false}
            checked={includeArchived}
            onToggle={setIncludeArchived}
          />
          <span>{t('schedulesIncludeArchived')}</span>
        </label>
      </div>
      {runRequested && (
        <StatusMessage kind="pending" data-testid="schedules-run-requested">
          {ux('runStarted')}
        </StatusMessage>
      )}
      <ScheduleEditor
        pageId={formOpen && top ? top : schedulePageId(undefined)}
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
        onCancel={nav.back}
        onSubmit={() => void save()}
      />
      {error !== undefined && api && !pending && (
        <StatusMessage
          kind="error"
          data-testid="schedules-error"
          action={{
            label: t('retry'),
            onSelect: () => {
              void refresh()
            },
          }}
        >
          {failureText(error, ux, t)}
        </StatusMessage>
      )}
      {api && (
        <Loadable
          loading={loading}
          error={list.error}
          hasData={list.data !== undefined}
          onRetry={list.reload}
          errorText={
            list.error === undefined ? undefined : (
              <span data-testid="schedules-error">{failureText(list.error, ux, t)}</span>
            )
          }
          shape="rows"
        >
          {visible.length === 0 && (
            <EmptyState
              data-testid="schedules-empty"
              icon={<Icon name="clock" size={48} />}
              title={t('schedulesEmpty')}
              description={t('schedulesHelp')}
              actions={
                <Button
                  appearance="primary"
                  icon={<Icon name="plus" size={16} />}
                  data-testid="schedules-empty-create"
                  disabled={!api || busy}
                  onClick={openNew}
                >
                  {ux('newSchedule')}
                </Button>
              }
            />
          )}
          {visible.length > 0 && (
            <SettingsList>
              {visible.map((row) => {
                const live = row.status === 'active' || row.status === 'paused'
                const last = row.runs.at(-1)
                const resultSession = last?.sessionKey
                const target = row.target
                const link = target.kind === 'session' ? target.sessionKey : undefined
                return (
                  <ListRow
                    key={row.id}
                    className="automation-row"
                    data-testid="schedules-row"
                    data-status={row.status}
                    data-target={target.kind}
                    icon={<Icon name="clock" size={16} />}
                    title={row.title}
                    {...(resultSession ? { onOpen: () => location.assign(sessionHref(resultSession)) } : {})}
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
                          {last?.sessionKey && (
                            <a data-testid="schedules-view-results" href={sessionHref(last.sessionKey)}>
                              {ux('viewResults')}
                            </a>
                          )}
                          <Button size="small" data-testid="schedules-edit" onClick={() => openEdit(row)}>
                            {ux('edit')}
                          </Button>
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
        </Loadable>
      )}
      {/* The empty state already says how a missed run is made up; the note is for a list that has rows. */}
      {visible.length > 0 && <p className="automation-note">{ux('missedNote')}</p>}
      <ConfirmDialog
        open={!!pending}
        title={t('schedulesConfirm')}
        confirmLabel={t('schedulesConfirm')}
        cancelLabel={t('schedulesCancel')}
        destructive
        busy={busy}
        testIds={{ confirm: 'schedules-archive-confirm', cancel: 'schedules-archive-cancel' }}
        onCancel={() => setPending(undefined)}
        onConfirm={() => {
          const id = pending
          if (!api || !id || busy) return
          const request = captureRequest(lifetime)
          setError(undefined)
          setBusy(true)
          void api
            .archive({ id })
            .then((result) => {
              if (!request.isCurrent()) return
              if ((result as { deleted?: boolean }).deleted === false) throw new Error('archive refused')
              setNotice(t('schedulesArchived'))
              setPending(undefined)
              return refresh()
            })
            .catch((reason: unknown) => {
              if (request.isCurrent()) setError(reason)
            })
            .finally(() => {
              if (request.isCurrent()) setBusy(false)
            })
        }}
      >
        <p>{t('schedulesConfirmBody')}</p>
        {pending && error !== undefined && <SettingsState tone="error">{t('schedulesError')}</SettingsState>}
      </ConfirmDialog>
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
