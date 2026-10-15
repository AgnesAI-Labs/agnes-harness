import { Button, Tabs } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { ActivityPage } from './activity.js'
import { DeviceDetail } from './detail.js'
import { DeveloperPage } from './developer.js'
import { ExamplesPage } from './examples.js'
import { WorldMap } from './map.js'
import { type Device, text } from './model.js'
import { HubHealth, Stop, useMhs, useSnapshot } from './react.js'
export function DeviceCard({ device }: { device: Device }) {
  const { openDevice, t } = useMhs(),
    numbers = Object.entries(device.state)
      .filter(([, v]) => typeof v === 'number')
      .slice(0, 3)
  return (
    <article className="mhs-device" data-state={!device.available ? 'offline' : device.health}>
      <Button appearance="link" onClick={() => openDevice(device.id)}>
        <strong>{device.name}</strong>
        <code>{device.id}</code>
      </Button>
      <span className="mhs-origin">
        {t(device.simulated === true ? 'simulated' : device.simulated === false ? 'real' : 'unclassified')}
      </span>
      <p>
        {t(device.available ? 'online' : 'offline')} · {device.health}
      </p>
      {Boolean(device.state.problem) && <p role="status">{String(device.state.problem)}</p>}
      <dl>
        {numbers.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
      <Stop device={device.id} />
    </article>
  )
}
export function MhsPage({ selection }: { selection?: unknown }) {
  const { t, store } = useMhs(),
    snapshot = useSnapshot(),
    [tab, setTab] = useState('devices'),
    [deviceId, setDeviceId] = useState<string>()
  useEffect(() => {
    if (
      typeof selection === 'object' &&
      selection !== null &&
      'device' in selection &&
      typeof selection.device === 'string'
    )
      setDeviceId(selection.device)
    else setDeviceId(undefined)
    if (typeof selection === 'object' && selection !== null && 'exampleId' in selection) setTab('examples')
  }, [selection])
  const device = snapshot.devices.find((d) => d.id === deviceId)
  if (device)
    return (
      <div className="mhs-root">
        <DeviceDetail
          key={`${device.id}:${device.revision}`}
          device={device}
          onBack={() => setDeviceId(undefined)}
        />
      </div>
    )
  const groups = new Map<string, Device[]>()
  for (const d of snapshot.devices) {
    const group =
      d.origin || t(d.simulated === true ? 'simulated' : d.simulated === false ? 'real' : 'unclassified')
    const entries = groups.get(group) ?? []
    entries.push(d)
    groups.set(group, entries)
  }
  const alerts = snapshot.devices.filter((d) => d.health === 'bad' || d.health === 'attention')
  const devices = (
    <>
      <div className="mhs-attention">
        {alerts.map((d) => (
          <Button key={d.id} onClick={() => setDeviceId(d.id)}>
            {d.name} · {text(d.state.problem) || d.health}
          </Button>
        ))}
      </div>
      {snapshot.status === 'loading' ? (
        <p role="status">{t('loading')}</p>
      ) : snapshot.status === 'failed' ? (
        <div role="alert">
          {t('failed')}
          <Button onClick={() => void store.refresh()}>{t('retry')}</Button>
        </div>
      ) : snapshot.devices.length === 0 ? (
        <div className="mhs-empty">
          <p>{t('empty')}</p>
          <Button onClick={() => setTab('developer')}>{t('mhs.developer')}</Button>
          <Button onClick={() => setTab('examples')}>{t('mhs.examples')}</Button>
        </div>
      ) : (
        [...groups].map(([name, devices]) => (
          <section key={name}>
            <h3>
              {name} · {devices.length}
            </h3>
            <div className="mhs-grid">
              {devices.map((d) => (
                <DeviceCard key={d.id} device={d} />
              ))}
            </div>
          </section>
        ))
      )}
    </>
  )
  return (
    <div className="mhs-root">
      <header className="mhs-header">
        <h2>MHS</h2>
        <HubHealth />
        <span>
          {t('online')} {snapshot.devices.filter((d) => d.available).length}/{snapshot.devices.length}
        </span>
        <span>
          {t('attention')} {alerts.length}
        </span>
        <Stop />
      </header>
      {deviceId && !device && (
        <div role="status">
          {deviceId} · {t('unavailable')}
          <Button onClick={() => setDeviceId(undefined)}>{t('back')}</Button>
        </div>
      )}
      {snapshot.streamError && (
        <p role="status">
          {t('unavailable')} · {snapshot.streamError}
          <Button onClick={() => void store.refresh()}>{t('retry')}</Button>
        </p>
      )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'devices', label: t('mhs.devices'), children: devices },
          {
            key: 'map',
            label: t('mhs.map'),
            children: <WorldMap maps={snapshot.maps} devices={snapshot.devices} />,
          },
          { key: 'activity', label: t('mhs.activity'), children: <ActivityPage /> },
          { key: 'developer', label: t('mhs.developer'), children: <DeveloperPage /> },
          {
            key: 'examples',
            label: t('mhs.examples'),
            children: (
              <ExamplesPage
                {...(typeof selection === 'object' &&
                selection !== null &&
                'exampleId' in selection &&
                typeof selection.exampleId === 'string'
                  ? { initialScene: selection.exampleId }
                  : {})}
              />
            ),
          },
        ]}
      />
    </div>
  )
}
