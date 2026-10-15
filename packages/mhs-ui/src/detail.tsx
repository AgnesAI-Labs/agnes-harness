import { Button } from '@agnes/web-ui'
import { Drive } from './drive.js'
import { StateField, ToolForm } from './forms.js'
import { type Device, jsonText, record } from './model.js'
import { HubHealth, Stop, useMhs } from './react.js'
import { Observation } from './widgets.js'
export function DeviceDetail({ device, onBack }: { device: Device; onBack(): void }) {
  const { t } = useMhs()
  return (
    <>
      <header className="mhs-header">
        <Button onClick={onBack}>← {t('back')}</Button>
        <h2>{device.name}</h2>
        <code>{device.id}</code>
        <HubHealth />
        <span>{t(device.online ? 'online' : 'offline')}</span>
        <Stop device={device.id} />
        <Stop />
      </header>
      <div className="mhs-detail">
        <div>
          <section className="mhs-box">
            <h3>{t('sources')}</h3>
            {device.sources.map((source) => (
              <Observation key={String(source.id)} source={source} device={device} />
            ))}
            {!device.sources.length && <p>—</p>}
          </section>
          <section className="mhs-box">
            <dl>
              {Object.entries(device.state).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{typeof v === 'object' ? jsonText(v) : String(v)}</dd>
                </div>
              ))}
            </dl>
          </section>
          <Drive device={device} />
        </div>
        <div>
          <section className="mhs-box">
            <h3>{t('actions')}</h3>
            {device.tools.map((tool) => (
              <ToolForm
                key={`${device.id}:${device.revision}:${String(tool.name)}`}
                device={device}
                tool={tool}
              />
            ))}
          </section>
          <section className="mhs-box">
            <h3>{t('settings')}</h3>
            {Object.entries(device.fields)
              .filter(([, raw]) => record(raw).writable === true)
              .map(([name, schema]) => (
                <StateField
                  key={`${device.revision}:${name}`}
                  device={device}
                  name={name}
                  schema={record(schema)}
                />
              ))}
          </section>
        </div>
      </div>
    </>
  )
}
