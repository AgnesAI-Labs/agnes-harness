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

export function SchedulesPage({ api, t }: { api?: SchedulesApi; t(key: string): string }) {
  const [scope, setScope] = useState<'session' | 'all'>('session')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [rows, setRows] = useState<ScheduleRow[]>([])
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState<string>()
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
    if (!api) return
    const key = sessionKey
    if (!key) {
      setError(t('schedulesOpenSession'))
      return
    }
    setError(undefined)
    try {
      const result = (await api.upsert({
        sessionKey: key,
        ...(id ? { id } : {}),
        title,
        prompt,
        selector: selectorOf(kind, when, zone, weekdays, cron),
      })) as { id?: string; code?: string; updated?: boolean }
      if (result.code || result.updated === false) {
        setError(result.code ?? t('schedulesError'))
        return
      }
      setNotice(id ? t('schedulesSaved') : t('schedulesCreated'))
      setEditing(undefined)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('schedulesError'))
    }
  }
  return (
    <div data-testid="schedules-page">
      <p>{t('schedulesHelp')}</p>
      {!api && (
        <p role="alert" data-testid="schedules-error">
          {t('schedulesUnavailable')}
        </p>
      )}
      <fieldset data-testid="schedules-scope" aria-label={t('schedulesScope')}>
        <button
          type="button"
          data-testid="schedules-scope-session"
          aria-pressed={scope === 'session'}
          onClick={() => setScope('session')}
        >
          {t('schedulesSession')}
        </button>
        <button
          type="button"
          data-testid="schedules-scope-all"
          aria-pressed={scope === 'all'}
          onClick={() => setScope('all')}
        >
          {t('schedulesAll')}
        </button>
      </fieldset>
      <label>
        <input
          type="checkbox"
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
        onSubmit={(event) => {
          event.preventDefault()
          void save(editing)
        }}
      >
        <label>
          {t('schedulesTitle')}
          <input
            data-testid="schedules-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          {t('schedulesPrompt')}
          <textarea
            data-testid="schedules-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label>
          {t('schedulesKind')}
          <select
            data-testid="schedules-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
          >
            {KINDS.map((item) => (
              <option key={item} value={item}>
                {t(`schedulesKind.${item}`)}
              </option>
            ))}
          </select>
        </label>
        {kind !== 'cron' && (
          <label>
            {t('schedulesWhen')}
            <input
              data-testid="schedules-when"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
          </label>
        )}
        {(kind === 'daily' || kind === 'weekly' || kind === 'cron') && (
          <label>
            {t('schedulesZone')}
            <input
              data-testid="schedules-zone"
              value={zone}
              onChange={(event) => setZone(event.target.value)}
            />
          </label>
        )}
        {kind === 'weekly' && (
          <fieldset data-testid="schedules-weekdays">
            <legend>{t('schedulesWeekdays')}</legend>
            {[0, 1, 2, 3, 4, 5, 6].map((day) => (
              <label key={day}>
                <input
                  type="checkbox"
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
          <label>
            {t('schedulesCron')}
            <input
              data-testid="schedules-cron"
              value={cron}
              onChange={(event) => setCron(event.target.value)}
            />
          </label>
        )}
        <button type="submit" data-testid={editing ? 'schedules-save' : 'schedules-create'}>
          {editing ? t('schedulesSave') : t('schedulesCreate')}
        </button>
      </form>
      {notice && (
        <p role="status" data-testid="schedules-notice">
          {notice}
        </p>
      )}
      {error !== undefined && api && (
        <p role="alert" data-testid="schedules-error">
          {error instanceof Error ? error.message : typeof error === 'string' ? error : t('schedulesError')}
        </p>
      )}
      {api && rows.length === 0 && !error && <p data-testid="schedules-empty">{t('schedulesEmpty')}</p>}
      <ul>
        {rows.map((row) => (
          <li key={row.id} data-testid="schedules-row">
            <button
              type="button"
              onClick={() => {
                setEditing(row.id)
                setTitle(row.title)
                setPrompt(row.prompt)
              }}
            >
              {row.title}
            </button>
            <span data-testid="schedules-next">
              {t('schedulesNext')}:{' '}
              {row.nextRunAt === null ? t('schedulesNone') : new Date(row.nextRunAt).toISOString()}
            </span>
            <span>
              {t('schedulesStatus')}: {row.status}
            </span>
            <details data-testid="schedules-history">
              <summary>{t('schedulesHistory')}</summary>
              <ul>
                {row.deliveries.map((delivery) => (
                  <li key={`${delivery.at}:${delivery.seq ?? ''}`}>
                    {new Date(delivery.at).toISOString()}
                    {delivery.reason ? ` ${delivery.reason}` : ''}
                  </li>
                ))}
              </ul>
            </details>
            {row.status === 'active' && (
              <button type="button" data-testid="schedules-archive" onClick={() => setPending(row.id)}>
                {t('schedulesArchive')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {pending && (
        <div role="dialog" aria-modal="true" aria-label={t('schedulesConfirm')}>
          <p>{t('schedulesConfirmBody')}</p>
          <button
            type="button"
            data-testid="schedules-archive-confirm"
            onClick={() => {
              const id = pending
              setPending(undefined)
              if (!api) return
              void api
                .archive({ id })
                .then(() => {
                  setNotice(t('schedulesArchived'))
                  return refresh()
                })
                .catch((reason: unknown) =>
                  setError(reason instanceof Error ? reason.message : t('schedulesError')),
                )
            }}
          >
            {t('schedulesConfirm')}
          </button>
          <button type="button" data-testid="schedules-archive-cancel" onClick={() => setPending(undefined)}>
            {t('schedulesCancel')}
          </button>
        </div>
      )}
    </div>
  )
}
