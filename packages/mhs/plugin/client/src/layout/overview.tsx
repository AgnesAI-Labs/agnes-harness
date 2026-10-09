/**
 * The overview (mhs-ui-design 13.1): one preview card per device, then what needs attention. A
 * card shows the device's own picture when it has one, otherwise its key numbers.
 */

import { displayName, keyFields, manualNow, previewImage, tone } from '../core/describe.js'
import type { Device } from '../core/types.js'
import { t } from '../i18n/i18n.js'
import { useDevices, useLocale, useNav } from '../react/hooks.js'
import { FieldView } from '../widgets/fields.js'
import { ImageView, VideoView } from '../widgets/image.js'
import { Doing, HealthText, PositionText, StatePill, StopButton } from './parts.js'

const PREVIEW_HZ = 5

export function DeviceCard(props: { device: Device }) {
  const nav = useNav()
  const d = props.device
  const picture = previewImage(d)
  const numbers = keyFields(d, picture ? 3 : 4)
  return (
    <article className="mhs-card" data-tone={tone(d)}>
      {picture && (
        <div className="mhs-card-preview">
          {picture.kind === 'video' ? (
            <VideoView device={d} source={picture} compact />
          ) : (
            <ImageView device={d} source={picture} hz={PREVIEW_HZ} compact />
          )}
        </div>
      )}
      <button type="button" className="mhs-card-open" onClick={() => nav.open(d.id)}>
        <header className="mhs-card-head">
          <span className="mhs-card-name mhs-mark">{displayName(d)}</span>
          <code className="mhs-card-id">{d.id}</code>
          <StatePill device={d} />
          <span className="mhs-card-chevron" aria-hidden="true">
            ›
          </span>
        </header>
        <div className="mhs-card-status">
          <HealthText health={d.health} />
          {d.position && <PositionText position={d.position} />}
        </div>
        <Doing device={d} compact />
      </button>
      {numbers.length > 0 && (
        <div className="mhs-fields mhs-card-fields">
          {numbers.map(([name, field]) => (
            <FieldView key={name} name={name} field={field} value={d.state.values[name]} />
          ))}
        </div>
      )}
      <footer className="mhs-card-foot">
        <StopButton device={d.id} />
      </footer>
    </article>
  )
}

function attentionOf(d: Device): string[] {
  const out: string[] = []
  if (!d.available) out.push(d.online ? t('device.connected') : t('device.offline'))
  if (d.health.level !== 'ok') out.push(`${t(`health.${d.health.level}`)}: ${d.health.reasons.join('; ')}`)
  if (d.position && d.position.trust !== 'trusted')
    out.push(`${t(`trust.${d.position.trust}`)}${d.position.reason ? `: ${d.position.reason}` : ''}`)
  for (const j of d.jobs ?? []) if (j.state === 'paused') out.push(t('device.paused', { tool: j.tool }))
  if (manualNow(d)) out.push(t('device.manual'))
  return out
}

export function Overview() {
  useLocale()
  const devices = useDevices()
  const nav = useNav()
  if (devices.length === 0)
    return (
      <div className="mhs-empty">
        <p>{t('overview.empty')}</p>
        <p className="mhs-dim">{t('overview.empty.hint')}</p>
      </div>
    )
  const watch = devices.map((d) => [d, attentionOf(d)] as const).filter(([, a]) => a.length > 0)
  return (
    <div className="mhs-overview">
      <div className="mhs-cards">
        {devices.map((d) => (
          <DeviceCard key={d.id} device={d} />
        ))}
      </div>
      {watch.length > 0 && (
        <section className="mhs-watch">
          <h3>{t('overview.watch')}</h3>
          {watch.map(([d, reasons]) => (
            <button type="button" key={d.id} className="mhs-watch-row" onClick={() => nav.open(d.id)}>
              <code>{d.id}</code> {reasons.join(' · ')}
            </button>
          ))}
        </section>
      )}
    </div>
  )
}
