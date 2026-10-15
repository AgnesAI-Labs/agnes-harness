import { Button } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsonText } from './model.js'
import type { ExampleView } from './ports.js'
import { QueryState, useMhs, useQuery } from './react.js'
export function ExamplesPage({ initialScene }: { initialScene?: string }) {
  const { client, t } = useMhs(),
    port = client.ports.examples,
    [scene, setScene] = useState<string | undefined>(initialScene),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [review, setReview] = useState<{
      id: string
      action: 'enable' | 'launch'
      token: string
      presentation: unknown
    }>(),
    lock = useRef(false)
  const query = useQuery(useCallback(async (signal: AbortSignal) => (port ? port.list(signal) : []), [port])),
    selected = query.value?.find((e) => e.id === scene)
  useEffect(() => port?.subscribe(query.retry), [port, query.retry])
  useEffect(() => {
    if (!query.value?.some((e) => e.state === 'starting')) return
    const timer = setTimeout(query.retry, 1000)
    return () => clearTimeout(timer)
  }, [query.value, query.retry])
  const run = async (action: 'enable' | 'stop' | 'launch', example: ExampleView, token?: string) => {
    if (!port || lock.current) return
    lock.current = true
    setBusy(true)
    setError(false)
    try {
      if (action === 'enable' && port.inspect && !token) {
        const r = await port.inspect(example.id)
        setReview({ id: example.id, action, token: r.reviewId, presentation: r.presentation })
        return
      }
      if (action === 'launch' && port.prepare && !token) {
        const r = await port.prepare(example.id)
        setReview({ id: example.id, action, token: r.launchTicket, presentation: r.presentation })
        return
      }
      await port[action](example.id, token)
      setReview(undefined)
      query.retry()
    } catch {
      setError(true)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  if (selected?.Scene && ['running', 'installed'].includes(selected.state))
    return (
      <section className="mhs-scene">
        <Button onClick={() => setScene(undefined)}>{t('back')}</Button>
        <selected.Scene onClose={() => setScene(undefined)} />
      </section>
    )
  return (
    <section>
      {query.error || !query.value ? (
        <QueryState error={query.error} retry={query.retry} />
      ) : query.value.length === 0 ? (
        <p className="mhs-empty">{t('noExamples')}</p>
      ) : (
        query.value.map((example) => (
          <article key={example.id} className="mhs-example">
            <div className="mhs-example-cover">
              <p>MHS · {t('simulated')}</p>
              <h2>{example.name}</h2>
              <p>{example.description}</p>
            </div>
            <div className="mhs-box">
              <p role="status">
                {example.state} {example.code}
              </p>
              {example.total !== undefined && (
                <p>
                  {example.connected ?? 0}/{example.total} {t('online')}
                </p>
              )}
              {['disabled', 'stopped', 'failed'].includes(example.state) && (
                <Button appearance="primary" disabled={busy} onClick={() => void run('enable', example)}>
                  {t(example.state === 'failed' ? 'retry' : 'enable')}
                </Button>
              )}
              {['running', 'installed'].includes(example.state) && (
                <>
                  <Button disabled={!example.Scene || busy} onClick={() => setScene(example.id)}>
                    {t('openScene')}
                  </Button>
                  <Button appearance="primary" disabled={busy} onClick={() => void run('launch', example)}>
                    {t('startSession')}
                  </Button>
                  {example.state === 'running' && (
                    <Button appearance="danger" disabled={busy} onClick={() => void run('stop', example)}>
                      {t('stopExample')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </article>
        ))
      )}
      {review && (
        <fieldset className="mhs-box">
          <legend>{t('confirm')}</legend>
          <pre>{jsonText(review.presentation)}</pre>
          <Button onClick={() => setReview(undefined)}>{t('cancel')}</Button>
          <Button
            disabled={busy}
            onClick={() => {
              const example = query.value?.find((e) => e.id === review.id)
              if (example) void run(review.action, example, review.token)
            }}
          >
            {t('run')}
          </Button>
        </fieldset>
      )}
      <Button onClick={query.retry}>{t('retry')}</Button>
      {error && <p role="alert">{t('unavailable')}</p>}
    </section>
  )
}
