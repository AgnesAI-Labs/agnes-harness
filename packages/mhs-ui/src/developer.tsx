import { Button, CopyButton } from '@agnes/web-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { jsonText, record, text } from './model.js'
import { QueryState, useMhs, useQuery, useSnapshot } from './react.js'
export function DeveloperPage() {
  const { client, t } = useMhs(),
    { devices } = useSnapshot(),
    [id, setId] = useState(''),
    [mode, setMode] = useState('local'),
    [address, setAddress] = useState(''),
    [allowlist, setAllowlist] = useState(''),
    [devicePort, setDevicePort] = useState('auto'),
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
      true,
    )
  useEffect(() => {
    if (
      status.value?.state !== 'starting' &&
      status.value?.state !== 'stopping' &&
      status.value?.mode !== 'external'
    )
      return
    const timer = setTimeout(status.retry, 1000)
    return () => clearTimeout(timer)
  }, [status.value?.state, status.value?.mode, status.retry])
  const configuredPort = status.value?.devicePort
  useEffect(() => {
    if (configuredPort !== undefined) setDevicePort(String(configuredPort))
  }, [configuredPort])
  const configuredAllowlist = status.value?.allowlist?.join('\n')
  useEffect(() => {
    if (status.value?.mode) setMode(status.value.mode)
    if (status.value?.address) {
      setAddress(status.value.address)
      setAllowlist(configuredAllowlist ?? status.value.address)
    }
  }, [status.value?.mode, status.value?.address, configuredAllowlist])
  const messageSequence = useRef(0)
  useEffect(() => {
    if (paused) return
    const abort = new AbortController()
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
                id: ++messageSequence.current,
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
  const checkAbort = useRef<AbortController>()
  const currentId = useRef(selectedId)
  currentId.current = selectedId
  // biome-ignore lint/correctness/useExhaustiveDependencies: Results belong to the selected device only.
  useEffect(() => {
    const abort = new AbortController()
    checkAbort.current = abort
    setChecks(undefined)
    setChecking(false)
    return () => abort.abort()
  }, [selectedId])
  const check = async () => {
    if (!port || !selected) return
    const selectedId = selected.id
    setChecking(true)
    try {
      const signal = AbortSignal.any([checkAbort.current?.signal ?? client.abort.signal, client.abort.signal])
      const result = await port.check(selectedId, signal)
      if (currentId.current === selectedId && !client.abort.signal.aborted) setChecks(result)
    } catch {
      setFailed(true)
    } finally {
      if (currentId.current === selectedId) setChecking(false)
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
                {status.value.state} · {status.value.mode} {status.value.code}
              </p>
              {Object.entries(status.value.endpoints ?? {}).map(([key, value]) => (
                <div className="mhs-endpoint" key={key}>
                  <span>{t(key === 'command' ? 'command' : 'observation')}</span>
                  <code>{value}</code>
                  <CopyButton label={t('copy')} copiedLabel={t('copied')} text={value} />
                </div>
              ))}
              <Button
                disabled={status.value.state !== 'failed'}
                onClick={() =>
                  void port
                    .retry()
                    .then(status.retry)
                    .catch(() => setFailed(true))
                }
              >
                {t('retry')}
              </Button>
              <details>
                <summary>{t('advancedHub')}</summary>
                <label>
                  {t('hubMode')}
                  <select value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="local">{t('localHub')}</option>
                    <option value="external">{t('externalHub')}</option>
                  </select>
                </label>
                {mode === 'external' && (
                  <>
                    <label>
                      {t('hubAddress')}
                      <input
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        placeholder="wss://192.0.2.10/mhs-peer/v1"
                      />
                    </label>
                    <label>
                      {t('hubAllowlist')}
                      <textarea value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />
                    </label>
                    <p>{t('hubBoundary')}</p>
                  </>
                )}
                <label>
                  {t('devicePort')}
                  <input
                    aria-label={t('devicePort')}
                    value={devicePort}
                    onChange={(event) => setDevicePort(event.target.value)}
                    placeholder={t('automaticPort')}
                  />
                </label>
                {port.configure && (
                  <Button
                    disabled={
                      (mode === 'external' &&
                        (!address.trim() || !allowlist.split('\n').includes(address))) ||
                      (devicePort !== 'auto' &&
                        (!Number.isInteger(Number(devicePort)) ||
                          Number(devicePort) < 1 ||
                          Number(devicePort) > 65535))
                    }
                    onClick={() =>
                      void port
                        .configure?.(
                          devicePort === 'auto' ? 'auto' : Number(devicePort),
                          mode === 'external'
                            ? { address, allowlist: allowlist.split('\n').filter(Boolean) }
                            : undefined,
                        )
                        .then(status.retry)
                        .catch(() => setFailed(true))
                    }
                  >
                    {t('external')}
                  </Button>
                )}
              </details>
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
