import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  ListRow,
  MetaText,
  Segmented,
  SettingsDetails,
  SettingsInput,
  SettingsList,
  SettingsPageActions,
  SettingsPageDescription,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  StateSwitch,
  StatusDot,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AUTOMATION_NAMESPACE, automationCatalog } from './automation-locale.js'
import { useSettingsOverlay } from './overlay.js'

export type SchedulesApi = {
  list(params: { scope: 'session' | 'all'; sessionKey?: string; includeArchived?: boolean }): Promise<unknown>
  upsert(params: unknown): Promise<unknown>
  archive(params: { id: string }): Promise<unknown>
  sessionKey(): string | undefined
}

type Delivery = { at: number; seq?: number; reason?: string }
type ScheduleRow = {
  id: string
  sessionKey: string
  title: string
  prompt: string
  selector: Record<string, unknown>
  status: string
  nextRunAt: number | null
  revision: number
  deliveries: Delivery[]
}

const KINDS = ['at', 'every_seconds', 'daily', 'weekly', 'cron', 'after_seconds'] as const
type Kind = (typeof KINDS)[number]
/** Everyday rules, in the order the form offers them; a Cron expression is an advanced option. */
const COMMON_KINDS = ['daily', 'weekly', 'at', 'after_seconds', 'every_seconds'] as const
type Text = (key: string, vars?: Record<string, string | number>) => string

/** Reminders run in this computer's time zone unless the user names another one. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const moment = (value: number | string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(document.documentElement.lang || 'en', { dateStyle: 'medium', timeStyle: 'short' })
}

function duration(seconds: number, ux: Text): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return String(seconds)
  if (seconds % 3600 === 0) return ux('hours', { count: seconds / 3600 })
  if (seconds % 60 === 0) return ux('minutes', { count: seconds / 60 })
  return ux('seconds', { count: seconds })
}

/** A schedule's rule in words: "Daily 09:00", "Weekly Fri 17:30", "Every 30 minutes". */
export function describeSchedule(selector: Record<string, unknown>, t: Text, ux: Text): string {
  const kind = KINDS.find((item) => item in selector)
  if (!kind) return ''
  const value = selector[kind]
  const fields = (value && typeof value === 'object' ? value : {}) as {
    time?: string
    weekdays?: number[]
    expr?: string
  }
  if (kind === 'daily') return `${t('schedulesKind.daily')} ${fields.time ?? ''}`.trim()
  if (kind === 'weekly')
    return [
      t('schedulesKind.weekly'),
      (fields.weekdays ?? []).map((day) => t(`schedulesDay.${day}`)).join(ux('listSeparator')),
      fields.time,
    ]
      .filter(Boolean)
      .join(' ')
  if (kind === 'cron') return `${t('schedulesKind.cron')} ${fields.expr ?? ''}`.trim()
  if (kind === 'at') return `${t('schedulesKind.at')} ${moment(String(value))}`
  return ux(kind === 'every_seconds' ? 'ruleEvery' : 'ruleAfter', { duration: duration(Number(value), ux) })
}

/** A value typed for one kind of rule rarely fits another; switching kinds starts from a sensible one. */
function whenFor(kind: Kind, current: string): string {
  if (kind === 'daily' || kind === 'weekly') return /^\d{1,2}:\d{2}$/.test(current) ? current : '09:00'
  if (kind === 'every_seconds' || kind === 'after_seconds') return /^\d+$/.test(current) ? current : '3600'
  return /^\d{4}-/.test(current) ? current : ''
}

function isRow(value: unknown): value is ScheduleRow {
  if (!value || typeof value !== 'object') return false
  const row = value as ScheduleRow
  return typeof row.id === 'string' && typeof row.title === 'string' && Array.isArray(row.deliveries)
}

function rowsOf(value: unknown): ScheduleRow[] {
  const schedules = (value as { schedules?: unknown } | undefined)?.schedules
  return Array.isArray(schedules) ? schedules.filter(isRow) : []
}

function selectorOf(
  kind: Kind,
  when: string,
  zone: string,
  weekdays: number[],
  cron: string,
): Record<string, unknown> {
  if (kind === 'after_seconds') return { after_seconds: Number(when) }
  if (kind === 'at') return { at: when }
  if (kind === 'every_seconds') return { every_seconds: Number(when) }
  if (kind === 'daily') return { daily: { time: when, timeZone: zone } }
  if (kind === 'weekly') return { weekly: { time: when, timeZone: zone, weekdays } }
  return zone ? { cron: { expr: cron, timeZone: zone } } : { cron: { expr: cron } }
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
  const zoneDefault = localTimeZone()
  const alive = useRef(true)
  const epoch = useRef(0)
  const [loading, setLoading] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [scope, setScope] = useState<'session' | 'all'>('session')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<Kind>('daily')
  const [when, setWhen] = useState('09:00')
  const [zone, setZone] = useState(zoneDefault)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [weekdays, setWeekdays] = useState<number[]>([1])
  const [cron, setCron] = useState('0 9 * * 1-5')
  useSettingsOverlay(formOpen || !!pending)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      epoch.current++
    }
  }, [])
  const sessionKey = api?.sessionKey()
  const refresh = useCallback(() => {
    if (!api) return Promise.resolve()
    if (scope === 'session' && !sessionKey) {
      setRows([])
      setError(undefined)
      return Promise.resolve()
    }
    const params =
      scope === 'session'
        ? { scope, ...(sessionKey ? { sessionKey } : {}), includeArchived }
        : { scope, includeArchived }
    const request = ++epoch.current
    setLoading(true)
    return api
      .list(params)
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
  }, [api, scope, sessionKey, includeArchived])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const save = async (id?: string) => {
    if (!api || busy) return
    const key = sessionKey
    if (!key) {
      setError('schedulesOpenSession')
      return
    }
    setError(undefined)
    setBusy(true)
    try {
      const result = (await api.upsert({
        sessionKey: key,
        ...(id ? { id } : {}),
        title,
        prompt,
        selector: selectorOf(kind, when, zone, weekdays, cron),
      })) as { id?: string; code?: string; updated?: boolean }
      if (!alive.current) return
      if (result.code || result.updated === false) {
        setError('schedulesError')
        return
      }
      setNotice(id ? 'schedulesSaved' : 'schedulesCreated')
      setEditing(undefined)
      setFormOpen(false)
      await refresh()
    } catch {
      if (alive.current) setError('schedulesError')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const create = (
    <Button
      appearance="primary"
      icon={<Icon name="plus" size={16} />}
      data-testid="schedules-new"
      disabled={!api || !sessionKey || busy}
      disabledReason={t('schedulesOpenSession')}
      onClick={() => {
        setEditing(undefined)
        setTitle('')
        setPrompt('')
        setKind('daily')
        setWhen('09:00')
        setZone(zoneDefault)
        setWeekdays([1])
        setCron('0 9 * * 1-5')
        setAdvancedOpen(false)
        setFormOpen(true)
      }}
    >
      {ux('newSchedule')}
    </Button>
  )
  const cronMode = kind === 'cron'
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
        <Segmented<'session' | 'all'>
          label={t('schedulesScope')}
          testId="schedules-scope"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'session', label: t('schedulesSession'), testId: 'schedules-scope-session' },
            { value: 'all', label: t('schedulesAll'), testId: 'schedules-scope-all' },
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
      {scope === 'session' && !sessionKey && (
        <Banner tone="info">
          <a data-testid="schedules-open-session" href="/">
            {t('schedulesOpenSession')}
          </a>
        </Banner>
      )}
      <Dialog
        focusable={{ focusTriggerAfterClose: false }}
        scrollLock={false}
        getContainer={() => document.body}
        open={formOpen}
        title={editing ? t('schedulesSave') : ux('newSchedule')}
        onCancel={() => {
          if (!busy) setFormOpen(false)
        }}
        footer={
          <>
            <Button disabled={busy} onClick={() => setFormOpen(false)}>
              {t('schedulesCancel')}
            </Button>
            <Button
              appearance="primary"
              htmlType="submit"
              form="schedules-editor"
              disabled={!api || !sessionKey || busy || !title.trim() || !prompt.trim()}
              loading={busy}
              data-testid={editing ? 'schedules-save' : 'schedules-create'}
            >
              {editing ? t('schedulesSave') : t('schedulesCreate')}
            </Button>
          </>
        }
      >
        <p className="automation-dialog-lead">{ux('formLead')}</p>
        <form
          id="schedules-editor"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault()
            if (!busy && api && sessionKey) void save(editing)
          }}
        >
          <Field label={t('schedulesTitle')}>
            <SettingsInput
              disabled={!api || !sessionKey || busy}
              required
              data-testid="schedules-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label={t('schedulesPrompt')}>
            <SettingsTextArea
              disabled={!api || !sessionKey || busy}
              required
              data-testid="schedules-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
          {!cronMode && (
            <Field label={ux('when')}>
              <SettingsSelect
                data-testid="schedules-kind"
                value={kind}
                onChange={(event) => {
                  const next = event.target.value as Kind
                  setKind(next)
                  setWhen((current) => whenFor(next, current))
                }}
              >
                {COMMON_KINDS.map((item) => (
                  <option key={item} value={item}>
                    {t(`schedulesKind.${item}`)}
                  </option>
                ))}
              </SettingsSelect>
            </Field>
          )}
          {!cronMode && (
            <Field
              label={
                kind === 'at'
                  ? ux('whenAt')
                  : kind === 'every_seconds' || kind === 'after_seconds'
                    ? ux('whenSeconds')
                    : t('schedulesWhen')
              }
            >
              <SettingsInput
                data-testid="schedules-when"
                {...(kind === 'daily' || kind === 'weekly'
                  ? { type: 'time' }
                  : kind === 'at'
                    ? { placeholder: ux('whenAtExample') }
                    : { type: 'number', min: 1, inputMode: 'numeric' as const })}
                value={when}
                onChange={(event) => setWhen(event.target.value)}
              />
            </Field>
          )}
          {kind === 'weekly' && (
            <fieldset data-testid="schedules-weekdays" className="automation-weekdays">
              <legend>{t('schedulesWeekdays')}</legend>
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <label key={day} htmlFor={`schedule-weekday-${day}`}>
                  <StateSwitch
                    id={`schedule-weekday-${day}`}
                    testId={`schedule-weekday-${day}`}
                    label={t(`schedulesDay.${day}`)}
                    disabled={busy || !api || !sessionKey}
                    checked={weekdays.includes(day)}
                    onToggle={(checked) =>
                      setWeekdays((current) =>
                        checked ? [...current, day].sort() : current.filter((item) => item !== day),
                      )
                    }
                  />
                  {t(`schedulesDay.${day}`)}
                </label>
              ))}
            </fieldset>
          )}
          {/* Time zone and Cron are for the few who need them: collapsed, with the value in effect shown. */}
          <SettingsDetails
            card
            title={ux('advanced')}
            summary={cronMode ? `${t('schedulesKind.cron')} ${cron}` : zone}
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            data-testid="schedules-advanced"
          >
            <Field label={t('schedulesZone')} hint={ux('zoneHelp')}>
              <SettingsInput
                data-testid="schedules-zone"
                disabled={kind !== 'daily' && kind !== 'weekly' && kind !== 'cron'}
                value={zone}
                onChange={(event) => setZone(event.target.value)}
              />
            </Field>
            <label className="agnes-settings-checkbox" htmlFor="schedules-cron-mode">
              <StateSwitch
                id="schedules-cron-mode"
                testId="schedules-cron-mode"
                label={ux('useCron')}
                disabled={busy}
                checked={cronMode}
                onToggle={(checked) => {
                  setKind(checked ? 'cron' : 'daily')
                  if (!checked) setWhen((current) => whenFor('daily', current))
                }}
              />
              {ux('useCron')}
            </label>
            {cronMode && (
              <Field label={t('schedulesCron')}>
                <SettingsInput
                  data-testid="schedules-cron"
                  value={cron}
                  onChange={(event) => setCron(event.target.value)}
                />
              </Field>
            )}
          </SettingsDetails>
        </form>
        {error !== undefined && <SettingsState tone="error">{t('schedulesError')}</SettingsState>}
      </Dialog>
      {notice && (
        <SettingsState tone="success" data-testid="schedules-notice">
          {t(notice)}
        </SettingsState>
      )}
      {error !== undefined && api && (
        <SettingsState tone="error" data-testid="schedules-error">
          {t(typeof error === 'string' && error === 'schedulesOpenSession' ? error : 'schedulesError')}
        </SettingsState>
      )}
      {api && rows.length === 0 && !error && (
        <EmptyState
          data-testid="schedules-empty"
          icon={<Icon name="clock" size={48} />}
          title={t('schedulesEmpty')}
          description={t('schedulesHelp')}
        />
      )}
      {rows.length > 0 && (
        <SettingsList>
          {rows.map((row) => {
            const live = row.status === 'active'
            return (
              <ListRow
                key={row.id}
                data-testid="schedules-row"
                data-status={row.status}
                icon={<Icon name="clock" size={16} />}
                title={row.title}
                description={describeSchedule(row.selector, t, ux)}
                onOpen={() => {
                  setFormOpen(true)
                  setEditing(row.id)
                  setTitle(row.title)
                  setPrompt(row.prompt)
                  const selected = KINDS.find((item) => item in row.selector)
                  let rowZone = zoneDefault
                  if (selected) {
                    setKind(selected)
                    const value = row.selector[selected]
                    if (value && typeof value === 'object') {
                      const fields = value as {
                        time?: string
                        timeZone?: string
                        weekdays?: number[]
                        expr?: string
                      }
                      rowZone = fields.timeZone ?? zoneDefault
                      setWhen(fields.time ?? '09:00')
                      setWeekdays(fields.weekdays ?? [1])
                      setCron(fields.expr ?? '0 9 * * 1-5')
                    } else setWhen(String(value ?? ''))
                  }
                  setZone(rowZone)
                  // What differs from the defaults is shown, not left for the user to find.
                  setAdvancedOpen(selected === 'cron' || rowZone !== zoneDefault)
                }}
                meta={
                  <span data-testid="schedules-next">
                    {t('schedulesNext')}:{' '}
                    {row.nextRunAt === null ? t('schedulesNone') : moment(row.nextRunAt)}
                  </span>
                }
                status={
                  row.status === 'failed' || row.status === 'paused' ? (
                    <Tag tone={row.status === 'failed' ? 'bad' : 'warn'}>
                      {t(`schedulesStatus.${row.status}`)}
                    </Tag>
                  ) : live ? (
                    <span className="automation-status">
                      <StatusDot tone="success" />
                      {t('schedulesStatus.active')}
                    </span>
                  ) : (
                    <MetaText>
                      {t(`schedulesStatus.${row.status === 'ended' ? 'completed' : row.status}`)}
                    </MetaText>
                  )
                }
                actions={
                  <>
                    {scope === 'all' && row.sessionKey !== sessionKey && (
                      <Button
                        size="small"
                        appearance="ghost"
                        data-testid="schedules-session"
                        href={`/?session=${encodeURIComponent(row.sessionKey)}`}
                      >
                        {ux('openSession')}
                      </Button>
                    )}
                    {live && (
                      <Button
                        size="small"
                        appearance="ghost"
                        data-testid="schedules-archive"
                        disabled={busy}
                        aria-label={ux('archiveLabel', { title: row.title })}
                        onClick={() => {
                          setError(undefined)
                          setPending(row.id)
                        }}
                      >
                        {t('schedulesArchive')}
                      </Button>
                    )}
                  </>
                }
              >
                {row.deliveries.length > 0 && (
                  <SettingsDetails
                    compact
                    title={ux('historyCount', { count: row.deliveries.length })}
                    data-testid="schedules-history"
                  >
                    <ul className="automation-history">
                      {row.deliveries.map((delivery) => (
                        <li
                          key={`${delivery.at}:${delivery.seq ?? ''}`}
                          data-failed={delivery.reason ? true : undefined}
                        >
                          <Icon name={delivery.reason ? 'x' : 'check'} size={16} />
                          {moment(delivery.at)}
                          <MetaText>
                            {delivery.reason ? t('schedulesDeliveryIssue') : t('schedulesStatus.fired')}
                          </MetaText>
                        </li>
                      ))}
                    </ul>
                  </SettingsDetails>
                )}
              </ListRow>
            )
          })}
        </SettingsList>
      )}
      {rows.length > 0 && <p className="automation-note">{ux('missedNote')}</p>}
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
        {typeof error === 'string' && <SettingsState tone="error">{t(error)}</SettingsState>}
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
                  setNotice('schedulesArchived')
                  setPending(undefined)
                  return refresh()
                })
                .catch(() => {
                  if (alive.current) setError('schedulesError')
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
