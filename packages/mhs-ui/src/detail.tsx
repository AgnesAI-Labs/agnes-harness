import { Button } from '@agnes/web-ui'
import { Drive } from './drive.js'
import { Fields, sourceGroup } from './fields.js'
import { JobView, StateField, ToolForm } from './forms.js'
import { catalog } from './locales.js'
import { type Device, record } from './model.js'
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
            {[...new Set(device.sources.map((s) => sourceGroup(s)))].map((group) => (
              <section key={group} aria-label={group || t('sources')}>
                {group && (
                  <h4>
                    {`group.${group}` in catalog.en ? t(`group.${group}` as keyof typeof catalog.en) : group}
                  </h4>
                )}
                {device.sources
                  .filter((s) => sourceGroup(s) === group)
                  .map((source) => (
                    <Observation key={String(source.id)} source={source} device={device} />
                  ))}
              </section>
            ))}
            {!device.sources.length && <p>—</p>}
          </section>
          <section className="mhs-box">
            <Fields fields={device.fields} values={device.state} />
          </section>
          <Drive device={device} />
        </div>
        <div>
          <section className="mhs-box">
            <h3>{t('jobs')}</h3>
            {device.jobs.map((job) => (
              <JobView key={String(job.id)} operation={job} device={device.id} />
            ))}
          </section>
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
