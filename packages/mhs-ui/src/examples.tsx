import { Button } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import type { ExampleView } from './ports.js'
import { QueryState, useMhs, useQuery } from './react.js'
export function ExamplesPage() {
  const { client, t } = useMhs(),
    port = client.ports.examples,
    [version, setVersion] = useState(0),
    [scene, setScene] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false)
  useEffect(() => port?.subscribe(() => setVersion((v) => v + 1)), [port])
  const query = useQuery(async (signal) => (port ? port.list(signal) : []), [port, version]),
    selected = query.value?.find((e) => e.id === scene)
  const run = async (action: 'enable' | 'stop' | 'launch', example: ExampleView) => {
    if (!port || busy) return
    setBusy(true)
    setError(false)
    try {
      await port[action](example.id)
      setVersion((v) => v + 1)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  if (selected?.Scene && selected.state === 'running')
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
              {example.state === 'running' && (
                <>
                  <Button disabled={!example.Scene || busy} onClick={() => setScene(example.id)}>
                    {t('openScene')}
                  </Button>
                  <Button appearance="primary" disabled={busy} onClick={() => void run('launch', example)}>
                    {t('startSession')}
                  </Button>
                  <Button appearance="danger" disabled={busy} onClick={() => void run('stop', example)}>
                    {t('stopExample')}
                  </Button>
                </>
              )}
            </div>
          </article>
        ))
      )}
      {error && <p role="alert">{t('unavailable')}</p>}
    </section>
  )
}
