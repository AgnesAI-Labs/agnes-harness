import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Icon,
  IconButton,
  ListRow,
  Menu,
  SettingsDetails,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
  SettingsToolbar,
  StateSwitch,
  Tag,
  useUiText,
} from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
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

export function SchedulesPage({ api, t }: { api?: SchedulesApi | undefined; t(key: string): string }) {
  const { t: ux } = useUiText(AUTOMATION_NAMESPACE, automationCatalog)
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
  const [zone, setZone] = useState('UTC')
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
  return (
    <section data-testid="schedules-page">
      <SettingsToolbar
        controls={
          <Button
            appearance="primary"
            data-testid="schedules-new"
            disabled={!api || !sessionKey || busy}
            disabledReason={t('schedulesOpenSession')}
            onClick={() => {
              setEditing(undefined)
              setTitle('')
              setPrompt('')
              setKind('daily')
              setWhen('09:00')
              setZone('UTC')
              setWeekdays([1])
              setCron('0 9 * * 1-5')
              setFormOpen(true)
            }}
          >
            {ux('newSchedule')}
          </Button>
        }
      />
      <p>{t('schedulesHelp')}</p>
      {loading && <SettingsState tone="loading">{t('loading')}</SettingsState>}
      {!api && (
        <SettingsState tone="error" data-testid="schedules-error">
          {t('schedulesUnavailable')}
        </SettingsState>
      )}
      <fieldset
        className="agnes-settings-actions"
        data-testid="schedules-scope"
        aria-label={t('schedulesScope')}
      >
        <Button
          htmlType="button"
          data-testid="schedules-scope-session"
          aria-pressed={scope === 'session'}
          appearance="ghost"
          onClick={() => setScope('session')}
        >
          {t('schedulesSession')}
        </Button>
        <Button
          htmlType="button"
          data-testid="schedules-scope-all"
          aria-pressed={scope === 'all'}
          appearance="ghost"
          onClick={() => setScope('all')}
        >
          {t('schedulesAll')}
        </Button>
      </fieldset>
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
      {scope === 'session' && !sessionKey && (
        <p>
          <a data-testid="schedules-open-session" href="/">
            {t('schedulesOpenSession')}
          </a>
        </p>
      )}
      <Dialog
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
          <Field label={t('schedulesKind')}>
            <SettingsSelect
              data-testid="schedules-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as Kind)}
            >
              {KINDS.map((item) => (
                <option key={item} value={item}>
                  {t(`schedulesKind.${item}`)}
                </option>
              ))}
            </SettingsSelect>
          </Field>
          {kind !== 'cron' && (
            <Field label={t('schedulesWhen')}>
              <SettingsInput
                data-testid="schedules-when"
                value={when}
                onChange={(event) => setWhen(event.target.value)}
              />
            </Field>
          )}
          {(kind === 'daily' || kind === 'weekly' || kind === 'cron') && (
            <Field label={t('schedulesZone')}>
              <SettingsInput
                data-testid="schedules-zone"
                value={zone}
                onChange={(event) => setZone(event.target.value)}
              />
            </Field>
          )}
          {kind === 'weekly' && (
            <fieldset data-testid="schedules-weekdays">
              <legend>{t('schedulesWeekdays')}</legend>
              {[0, 1, 2, 3, 4, 5, 6].map((day) => (
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
          {kind === 'cron' && (
            <Field label={t('schedulesCron')}>
              <SettingsInput
                data-testid="schedules-cron"
                value={cron}
                onChange={(event) => setCron(event.target.value)}
              />
            </Field>
          )}
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
      <div className="agnes-settings-list">
        {rows.map((row) => (
          <ListRow
            key={row.id}
            data-testid="schedules-row"
            title={row.title}
            onOpen={() => {
              setFormOpen(true)
              setEditing(row.id)
              setTitle(row.title)
              setPrompt(row.prompt)
              const selected = KINDS.find((item) => item in row.selector)
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
                  setWhen(fields.time ?? '09:00')
                  setZone(fields.timeZone ?? 'UTC')
                  setWeekdays(fields.weekdays ?? [1])
                  setCron(fields.expr ?? '0 9 * * 1-5')
                } else setWhen(String(value ?? ''))
              }
            }}
            status={
              row.status !== 'paused' && row.status !== 'failed' ? undefined : (
                <Tag tone={row.status === 'failed' ? 'bad' : 'warn'}>
                  {t(`schedulesStatus.${row.status}`)}
                </Tag>
              )
            }
            actions={
              row.status === 'active' ? (
                <Menu
                  label={ux('actions')}
                  trigger={
                    <IconButton name="ellipsis" label={ux('actions')} data-testid="schedules-archive" />
                  }
                  items={[
                    {
                      id: 'archive',
                      label: t('schedulesArchive'),
                      danger: true,
                      disabled: busy,
                      onSelect: () => {
                        setError(undefined)
                        setPending(row.id)
                      },
                    },
                  ]}
                />
              ) : undefined
            }
          >
            <span data-testid="schedules-next">
              {t('schedulesNext')}:{' '}
              {row.nextRunAt === null
                ? t('schedulesNone')
                : new Date(row.nextRunAt).toLocaleString(document.documentElement.lang || 'en')}
            </span>
            <SettingsDetails title={t('schedulesHistory')} data-testid="schedules-history">
              <ul>
                {row.deliveries.map((delivery) => (
                  <li key={`${delivery.at}:${delivery.seq ?? ''}`}>
                    {new Date(delivery.at).toLocaleString(document.documentElement.lang || 'en')}
                    {delivery.reason ? ` · ${t('schedulesDeliveryIssue')}` : ''}
                  </li>
                ))}
              </ul>
            </SettingsDetails>
          </ListRow>
        ))}
      </div>
      <Dialog
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
