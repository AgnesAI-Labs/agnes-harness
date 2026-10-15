import { Button, CopyButton } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsonText, record, text } from './model.js'
import { QueryState, useMhs, useQuery, useSnapshot } from './react.js'
export function DeveloperPage() {
  const { client, t } = useMhs(),
    { devices } = useSnapshot(),
    [id, setId] = useState(''),
    [language, setLanguage] = useState('ts'),
    [paused, setPaused] = useState(false),
    [filter, setFilter] = useState('all'),
    [messages, setMessages] = useState<{ id: number; protocol: string; summary: string }[]>([]),
    [failed, setFailed] = useState(false),
    [checks, setChecks] = useState<readonly { name: string; state: string; detail?: string }[]>(),
    [checking, setChecking] = useState(false)
  const selected = devices.find((d) => d.id === id) ?? devices[0],
    port = client.ports.developer,
    status = useQuery(
      useCallback(async (signal: AbortSignal) => (port ? port.status(signal) : undefined), [port]),
    )
  useEffect(() => {
    if (paused) return
    const abort = new AbortController()
    let seq = 0
    // Only sanitized metadata from the owner-bound diagnostics stream is rendered.
    void client
      .stream(
        'events',
        {},
        (frame) => {
          if (frame instanceof Uint8Array) return
          const m = record(frame)
          const summary =
            typeof m.summary === 'string'
              ? m.summary.slice(0, 2048)
              : [text(m.type), text(m.device), text(m.source), text(m.call)].filter(Boolean).join(' ')
          if (!summary) return
          setMessages((prior) =>
            [
              ...prior,
              {
                id: ++seq,
                protocol: text(m.protocol) || (m.type === 'observation' ? 'mos' : 'mhs'),
                summary,
              },
            ].slice(-200),
          )
        },
        abort.signal,
      )
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true)
      })
    return () => abort.abort()
  }, [client, paused])
  const selectedId = selected?.id
  const currentId = useRef(selectedId)
  currentId.current = selectedId
  // biome-ignore lint/correctness/useExhaustiveDependencies: Results belong to the selected device only.
  useEffect(() => {
    setChecks(undefined)
  }, [selectedId])
  const check = async () => {
    if (!port || !selected) return
    const selectedId = selected.id
    setChecking(true)
    try {
      const result = await port.check(selectedId, client.abort.signal)
      if (currentId.current === selectedId && !client.abort.signal.aborted) setChecks(result)
    } catch {
      setFailed(true)
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="mhs-detail">
      <div>
        <section className="mhs-box">
          <h3>{t('mhs.developer')}</h3>
          <label>
            SDK
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="ts">TypeScript</option>
              <option value="py">Python</option>
            </select>
          </label>
          <pre>{language === 'ts' ? tsSnippet : pythonSnippet}</pre>
          <nav>
            <a href="https://github.com/AgnesAI-Labs/agnes-harness/tree/main/packages/mhs-device">SDK</a> ·{' '}
            <a href="https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/guide/mhs.md">MHS</a> ·{' '}
            <a href="https://github.com/AgnesAI-Labs/agnes-harness/blob/main/docs/guide/security.md">
              Safety
            </a>
          </nav>
        </section>
        <section className="mhs-box">
          <h3>Hub</h3>
          {status.error ? (
            <QueryState error retry={status.retry} />
          ) : !port ? (
            <p>{t('noDeveloper')}</p>
          ) : !status.value ? (
            <p>{t('loading')}</p>
          ) : (
            <>
              <p role="status">
                {status.value.state} {status.value.code}
              </p>
              {Object.entries(status.value.endpoints ?? {}).map(([key, value]) => (
                <div className="mhs-endpoint" key={key}>
                  <span>{t(key === 'command' ? 'command' : 'observation')}</span>
                  <code>{value}</code>
                  <CopyButton label={t('copy')} copiedLabel={t('copied')} text={value} />
                </div>
              ))}
              <Button
                onClick={() =>
                  void port
                    .retry()
                    .then(status.retry)
                    .catch(() => setFailed(true))
                }
              >
                {t('retry')}
              </Button>
              {port.configureExternal && (
                <Button onClick={() => void port.configureExternal?.().catch(() => setFailed(true))}>
                  {t('external')}
                </Button>
              )}
            </>
          )}
        </section>
        {failed && <p role="alert">{t('unavailable')}</p>}
      </div>
      <div>
        <section className="mhs-box">
          <h3>{t('raw')}</h3>
          <select
            aria-label={t('mhs.devices')}
            value={selected?.id ?? ''}
            onChange={(e) => setId(e.target.value)}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <pre>{selected ? jsonText(selected.description) : '—'}</pre>
        </section>
        <section className="mhs-box">
          <h3>{t('messages')}</h3>
          <label>
            Protocol
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">{t('all')}</option>
              <option value="mhs">MHS</option>
              <option value="mos">MOS</option>
            </select>
          </label>
          <Button onClick={() => setPaused((v) => !v)}>{t(paused ? 'continue' : 'pause')}</Button>
          <ol>
            {messages
              .filter((m) => filter === 'all' || m.protocol === filter)
              .map((m) => (
                <li key={m.id}>
                  <code>
                    {m.protocol} {m.summary}
                  </code>
                </li>
              ))}
          </ol>
        </section>
        <section className="mhs-box">
          <h3>{t('check')}</h3>
          <Button disabled={!port || !selected || checking} onClick={() => void check()}>
            {t('check')}
          </Button>
          {checks?.map((check) => (
            <p key={check.name}>
              {check.name} · {check.state} {check.detail}
            </p>
          ))}
        </section>
      </div>
    </div>
  )
}

const tsSnippet = `import { Device, connectDevice } from '@agnes/mhs-device'

const device = new Device({
  protocol: 'mhs/v1',
  device: { id: 'sensor-01', kind: 'sensor' },
  state: { temperature: { type: 'number', unit: '°C' } },
})
device.update({ temperature: 22 })
const lifetime = new AbortController()
await connectDevice(device, HUB_DEVICE_ENDPOINT, lifetime.signal)`
const pythonSnippet = `import asyncio
from agnes_mhs import Device, connect_device

device = Device({
    "protocol": "mhs/v1",
    "device": {"id": "sensor-01", "kind": "sensor"},
    "state": {"temperature": {"type": "number", "unit": "°C"}},
})
device.update({"temperature": 22})
asyncio.run(connect_device(device, HUB_DEVICE_ENDPOINT))`
