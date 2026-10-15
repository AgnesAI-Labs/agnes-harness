import { Button } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { type Activity, isException, jsonText, record, text } from './model.js'
import { QueryState, useMhs, useSnapshot } from './react.js'
export function ActivityPage() {
  const { client, t, openDevice } = useMhs(),
    snapshot = useSnapshot(),
    [sessionOnly, setSessionOnly] = useState(false),
    [exceptions, setExceptions] = useState(false),
    [device, setDevice] = useState('')
  const [events, setEvents] = useState<Activity[]>([]),
    [earliest, setEarliest] = useState<number | null>(null),
    [cursor, setCursor] = useState<string>(),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [page, setPage] = useState('')
  const sessionId = sessionOnly ? snapshot.sessionId : undefined
  // biome-ignore lint/correctness/useExhaustiveDependencies: A filter change resets the pagination cursor.
  useEffect(() => {
    setPage('')
    setEvents([])
    setCursor(undefined)
  }, [sessionId, device])
  useEffect(() => {
    if (!snapshot.sessionId) setSessionOnly(false)
  }, [snapshot.sessionId])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry repeats this bounded query.
  useEffect(() => {
    const abort = new AbortController()
    setLoading(true)
    setError(false)
    void client
      .activity(
        {
          ...(device ? { device } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(page ? { cursor: page } : {}),
          limit: 100,
        },
        abort.signal,
      )
      .then((result) => {
        if (abort.signal.aborted) return
        setEvents((prior) =>
          page
            ? [...prior, ...result.events.filter((e) => !prior.some((p) => p.id === e.id))]
            : result.events,
        )
        setEarliest(result.earliest)
        setCursor(result.nextCursor)
        setLoading(false)
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setError(true)
          setLoading(false)
        }
      })
    return () => abort.abort()
  }, [client, sessionId, device, page, revision])
  const visible = events.filter((e) => !exceptions || isException(e))
  return (
    <section>
      <div className="mhs-filters">
        <label>
          {t('allDevices')}
          <select value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">{t('all')}</option>
            {snapshot.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={sessionOnly}
            disabled={!snapshot.sessionId}
            onChange={(e) => setSessionOnly(e.target.checked)}
          />
          {t('currentSession')}
        </label>
        {!snapshot.sessionId && <small>{t('noSession')}</small>}
        <label>
          <input type="checkbox" checked={exceptions} onChange={(e) => setExceptions(e.target.checked)} />
          {t('exceptions')}
        </label>
        <span>
          {t('retention')} · {t('earliest')} {earliest === null ? '—' : new Date(earliest).toLocaleString()}
        </span>
        <Button
          onClick={() => {
            setPage('')
            setRevision((v) => v + 1)
          }}
        >
          {t('retry')}
        </Button>
      </div>
      {error || loading ? (
        <QueryState error={error} retry={() => setRevision((v) => v + 1)} />
      ) : visible.length === 0 ? (
        <QueryState error={false} empty retry={() => {}} />
      ) : (
        <ol className="mhs-events">
          {visible.map((event) => {
            const detail = record(event.detail)
            return (
              <li key={event.id}>
                <time dateTime={new Date(event.at).toISOString()}>{new Date(event.at).toLocaleString()}</time>
                <Button appearance="link" onClick={() => openDevice(event.device)} disabled={!event.device}>
                  {event.device || '—'}
                </Button>
                <span>{event.type}</span>
                <span>
                  {text(detail.actor) || '—'} {detail.approved === true ? '✓' : ''}
                </span>
                <pre>{jsonText(event.detail)}</pre>
              </li>
            )
          })}
        </ol>
      )}
      {cursor && (
        <Button disabled={loading} onClick={() => setPage(cursor)}>
          {t('loadMore')}
        </Button>
      )}
    </section>
  )
}
