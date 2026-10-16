import { Button } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { HubDependency, useHub } from './hub.js'
import { stateLabel } from './locales.js'
import { jsonText } from './model.js'
import type { ExampleView } from './ports.js'
import { QueryState, useMhs, useQuery } from './react.js'
export function ExamplesPage({ initialScene }: { initialScene?: string }) {
  const { client, t } = useMhs(),
    port = client.ports.examples,
    hub = useHub(),
    [scene, setScene] = useState<string | undefined>(initialScene),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [createdSession, setCreatedSession] = useState<string>(),
    [review, setReview] = useState<{
      id: string
      action: 'enable' | 'launch' | 'remove'
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
    action: 'enable' | 'stop' | 'launch' | 'remove',
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
      if (action === 'remove' && port.inspectRemove && !token) {
        const r = await port.inspectRemove(example.id)
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
      const result =
        action === 'remove'
          ? await port.remove?.(example.id, token ?? '')
          : await port[action](example.id, token)
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
        disabled={hub.blocked || busy || (example.requiresRuntime === true && example.state !== 'running')}
        onClick={() => void run('launch', example, undefined, launch.id || undefined)}
      >
        {example.id === '@agnes-example/mars-rescue' && (launch.id === 'rescue' || launch.id === 'sample')
          ? t(`mars.${launch.id}`)
          : launch.title}
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
  if (selected?.Scene && !hub.blocked)
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
      {hub.blocked && <HubDependency panel="examples" />}
      {query.error || !query.value ? (
        !hub.blocked && <QueryState error={query.error} retry={query.retry} />
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
            <div className="mhs-box mhs-example-actions">
              {example.installed && port?.remove && (
                <Button
                  appearance="danger"
                  disabled={busy || !['disabled', 'stopped'].includes(example.state)}
                  onClick={() => void run('remove', example)}
                >
                  {t('removeExample')}
                </Button>
              )}
              {example.installed &&
                ['failed', 'starting', 'installed', 'unavailable'].includes(example.state) && (
                  <Button disabled={busy} onClick={() => void run('stop', example)}>
                    {t('stopExample')}
                  </Button>
                )}
              <p role="status">{stateLabel(t, example.state)}</p>
              {example.code && (
                <details>
                  <summary>{t('details')}</summary>
                  <pre>{example.code}</pre>
                </details>
              )}
              {example.total !== undefined && (
                <p>
                  {example.connected ?? 0}/{example.total} {t('online')}
                </p>
              )}
              {!hub.blocked &&
                !example.Scene &&
                ['disabled', 'stopped', 'failed'].includes(example.state) && (
                  <Button appearance="primary" disabled={busy} onClick={() => void run('enable', example)}>
                    {t(example.state === 'failed' ? 'retry' : 'enable')}
                  </Button>
                )}
              {(example.Scene || ['running', 'installed'].includes(example.state)) && (
                <>
                  <Button
                    disabled={hub.blocked || !example.Scene || busy}
                    onClick={() => setScene(example.id)}
                  >
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
      {!hub.blocked && query.value && !query.error && <Button onClick={query.retry}>{t('refresh')}</Button>}
    </section>
  )
}
