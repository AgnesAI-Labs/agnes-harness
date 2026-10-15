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
    [createdSession, setCreatedSession] = useState<string>(),
    [review, setReview] = useState<{
      id: string
      action: 'enable' | 'launch'
      token: string
      presentation: unknown
    }>(),
    lock = useRef(false),
    previousScene = useRef<ExampleView>()
  useEffect(() => setScene(initialScene), [initialScene])
  const query = useQuery(useCallback(async (signal: AbortSignal) => (port ? port.list(signal) : []), [port])),
    selected =
      query.value?.find((e) => e.id === scene) ??
      (!query.value && !query.error && previousScene.current?.id === scene
        ? previousScene.current
        : undefined)
  if (query.value) previousScene.current = selected
  useEffect(() => port?.subscribe(query.retry), [port, query.retry])
  useEffect(() => {
    if (!query.value?.some((e) => e.state === 'starting' || e.state === 'running' || e.state === 'installed'))
      return
    const timer = setTimeout(query.retry, 1000)
    return () => clearTimeout(timer)
  }, [query.value, query.retry])
  const run = async (
    action: 'enable' | 'stop' | 'launch',
    example: ExampleView,
    token?: string,
    launchId?: string,
  ) => {
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
      if (action === 'launch' && example.requiresRuntime && example.state !== 'running')
        throw new Error('example-runtime-unavailable')
      if (action === 'launch' && port.prepare && !token) {
        const r = await port.prepare(example.id, launchId)
        setReview({ id: example.id, action, token: r.launchTicket, presentation: r.presentation })
        return
      }
      const result = await port[action](example.id, token)
      if (result && 'sessionId' in result) setCreatedSession(result.sessionId)
      setReview(undefined)
      query.retry()
    } catch {
      setError(true)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const launchButtons = (example: ExampleView) =>
    (example.launches?.length ? example.launches : [{ id: '', title: t('startSession') }]).map((launch) => (
      <Button
        key={launch.id}
        appearance="primary"
        disabled={busy || (example.requiresRuntime === true && example.state !== 'running')}
        onClick={() => void run('launch', example, undefined, launch.id || undefined)}
      >
        {launch.title}
      </Button>
    ))
  const feedback = (
    <>
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
      {createdSession && (
        <p role="status">
          {t('sessionCreated')} · <code>{createdSession}</code>
        </p>
      )}
      {error && <p role="alert">{t('unavailable')}</p>}
    </>
  )
  if (selected?.Scene)
    return (
      <section className="mhs-scene">
        <Button onClick={() => setScene(undefined)}>{t('backExamples')}</Button>
        {launchButtons(selected)}
        {feedback}
        <selected.Scene
          onClose={() => setScene(undefined)}
          onLaunch={(launchId) => void run('launch', selected, undefined, launchId)}
        />
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
              {!example.Scene && ['disabled', 'stopped', 'failed'].includes(example.state) && (
                <Button appearance="primary" disabled={busy} onClick={() => void run('enable', example)}>
                  {t(example.state === 'failed' ? 'retry' : 'enable')}
                </Button>
              )}
              {(example.Scene || ['running', 'installed'].includes(example.state)) && (
                <>
                  <Button disabled={!example.Scene || busy} onClick={() => setScene(example.id)}>
                    {t('openScene')}
                  </Button>
                  {launchButtons(example)}
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
      {feedback}
      <Button onClick={query.retry}>{t('retry')}</Button>
    </section>
  )
}
