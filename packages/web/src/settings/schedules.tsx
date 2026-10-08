import {
  Button,
  Dialog,
  Field,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsState,
  SettingsTextArea,
} from '@agnes/web-ui'
import { useCallback, useEffect, useState } from 'react'

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
    return api
      .list(params)
      .then((value) => {
        setRows(rowsOf(value))
        setError(undefined)
      })
      .catch((reason: unknown) => setError(reason))
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
      if (result.code || result.updated === false) {
        setError('schedulesError')
        return
      }
      setNotice(id ? 'schedulesSaved' : 'schedulesCreated')
      setEditing(undefined)
      await refresh()
    } catch {
      setError('schedulesError')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsCard data-testid="schedules-page">
      <p>{t('schedulesHelp')}</p>
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
          type={scope === 'session' ? 'primary' : 'default'}
          onClick={() => setScope('session')}
        >
          {t('schedulesSession')}
        </Button>
        <Button
          htmlType="button"
          data-testid="schedules-scope-all"
          aria-pressed={scope === 'all'}
          type={scope === 'all' ? 'primary' : 'default'}
          onClick={() => setScope('all')}
        >
          {t('schedulesAll')}
        </Button>
      </fieldset>
      <label className="agnes-settings-checkbox" htmlFor="schedules-include-archived">
        <SettingsInput
          type="checkbox"
          id="schedules-include-archived"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
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
      <form
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
                <SettingsInput
                  type="checkbox"
                  id={`schedule-weekday-${day}`}
                  checked={weekdays.includes(day)}
                  onChange={(event) =>
                    setWeekdays((current) =>
                      event.target.checked
                        ? [...current, day].sort()
                        : current.filter((item) => item !== day),
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
        <Button
          htmlType="submit"
          disabled={!api || !sessionKey || busy || !title.trim() || !prompt.trim()}
          loading={busy}
          data-testid={editing ? 'schedules-save' : 'schedules-create'}
        >
          {editing ? t('schedulesSave') : t('schedulesCreate')}
        </Button>
      </form>
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
      {api && rows.length === 0 && !error && <p data-testid="schedules-empty">{t('schedulesEmpty')}</p>}
      <ul className="agnes-settings-list">
        {rows.map((row) => (
          <li key={row.id} data-testid="schedules-row">
            <Button
              htmlType="button"
              onClick={() => {
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
            >
              {row.title}
            </Button>
            <span data-testid="schedules-next">
              {t('schedulesNext')}:{' '}
              {row.nextRunAt === null
                ? t('schedulesNone')
                : new Date(row.nextRunAt).toLocaleString(document.documentElement.lang || 'en')}
            </span>
            <span>
              {t('schedulesStatus')}: {t(`schedulesStatus.${row.status}`)}
            </span>
            <details data-testid="schedules-history">
              <summary>{t('schedulesHistory')}</summary>
              <ul>
                {row.deliveries.map((delivery) => (
                  <li key={`${delivery.at}:${delivery.seq ?? ''}`}>
                    {new Date(delivery.at).toLocaleString(document.documentElement.lang || 'en')}
                    {delivery.reason ? ` · ${t('schedulesDeliveryIssue')}` : ''}
                  </li>
                ))}
              </ul>
            </details>
            {row.status === 'active' && (
              <Button
                htmlType="button"
                disabled={busy}
                data-testid="schedules-archive"
                onClick={() => {
                  setError(undefined)
                  setPending(row.id)
                }}
              >
                {t('schedulesArchive')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {pending && (
        <Dialog
          open
          title={t('schedulesConfirm')}
          footer={null}
          onCancel={() => {
            if (!busy) setPending(undefined)
          }}
        >
          <p>{t('schedulesConfirmBody')}</p>
          {error && <SettingsState tone="error">{t(error)}</SettingsState>}
          <Button
            htmlType="button"
            data-testid="schedules-archive-confirm"
            disabled={busy}
            loading={busy}
            onClick={() => {
              const id = pending
              if (!api || busy) return
              setError(undefined)
              setBusy(true)
              void api
                .archive({ id })
                .then(() => {
                  setNotice('schedulesArchived')
                  setPending(undefined)
                  return refresh()
                })
                .catch(() => setError('schedulesError'))
                .finally(() => setBusy(false))
            }}
          >
            {t('schedulesConfirm')}
          </Button>
          <Button
            htmlType="button"
            data-testid="schedules-archive-cancel"
            disabled={busy}
            onClick={() => setPending(undefined)}
          >
            {t('schedulesCancel')}
          </Button>
        </Dialog>
      )}
    </SettingsCard>
  )
}
