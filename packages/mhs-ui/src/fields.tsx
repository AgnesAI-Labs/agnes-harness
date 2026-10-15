import { catalog, type Translate } from './locales.js'
import { type Data, type Device, jsonText, number, record, text } from './model.js'
import { useMhs } from './react.js'

export function fieldLabel(name: string, field: Data, t?: Translate): string {
  const role = text(field.role)
  return (
    text(record(field.ui).label) ||
    (role === 'consumable'
      ? text(field.of) || name
      : role && !role.startsWith('x_')
        ? [
            text(field.of),
            t && `role.${role}` in catalog.en
              ? t(`role.${role}` as keyof typeof catalog.en)
              : role.replaceAll('_', ' '),
          ]
            .filter(Boolean)
            .join(' ')
        : name)
  )
}
export function alertLevel(field: Data, value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'ok'
  const alert = record(field.alert)
  const hit = (threshold: unknown) =>
    typeof threshold === 'number' && (alert.below === true ? value <= threshold : value >= threshold)
  return hit(alert.bad) ? 'bad' : hit(alert.warn) ? 'attention' : 'ok'
}
export function Fields({ fields, values }: { fields: Data; values: Data }) {
  const { t } = useMhs()
  return (
    <dl className="mhs-fields">
      {Object.entries(fields)
        .filter(([, f]) => record(record(f).ui).hidden !== true)
        .map(([name, raw]) => {
          const f = record(raw),
            value = values[name],
            label = fieldLabel(name, f, t)
          return (
            <div key={name} data-alert={alertLevel(f, value)} title={text(f.description)}>
              <dt>{label}</dt>
              <dd>
                {value === undefined
                  ? '—'
                  : typeof value === 'object'
                    ? jsonText(value)
                    : `${String(value)}${text(f.unit) ? ` ${text(f.unit)}` : ''}`}
              </dd>
              {typeof value === 'number' &&
                typeof f.min === 'number' &&
                typeof f.max === 'number' &&
                f.max > f.min && <meter aria-label={label} min={f.min} max={f.max} value={number(value)} />}
            </div>
          )
        })}
    </dl>
  )
}

/** A compact card follows explicit tiles, then semantic/alert fields, then ordinary status. */
export function keyFields(fields: Data): [string, unknown][] {
  const visible = Object.entries(fields).filter(
    ([name, raw]) => !['problem', 'faults'].includes(name) && record(record(raw).ui).hidden !== true,
  )
  const tiled = visible.filter(([, raw]) => record(record(raw).ui).tile === true)
  if (tiled.length) return tiled.slice(0, 4)
  return [
    ...visible.filter(([, raw]) => record(raw).role || record(raw).alert),
    ...visible.filter(([, raw]) => !record(raw).role && !record(raw).alert),
  ].slice(0, 4)
}
export function sourceGroup(source: Data): string {
  if (text(record(source.ui).group)) return text(record(source.ui).group)
  const kind = text(source.kind)
  return ['image', 'video', 'detections'].includes(kind)
    ? 'picture'
    : ['scan', 'points', 'grid'].includes(kind)
      ? 'ranging'
      : ['pose', 'world', 'gnss', 'odometry'].includes(kind)
        ? 'place'
        : ['values', 'switch', 'imu'].includes(kind)
          ? 'telemetry'
          : kind === 'audio'
            ? 'sound'
            : ['text', 'transcript'].includes(kind)
              ? 'text'
              : 'other'
}

export function deviceTone(device: Device): string {
  if (!device.available) return 'offline'
  if (device.health === 'bad') return 'bad'
  if (device.health === 'attention' || device.jobs.some((j) => j.phase === 'paused')) return 'attention'
  return device.jobs.some((j) => j.state === 'running' || j.state === 'accepted') ? 'busy' : 'ok'
}
