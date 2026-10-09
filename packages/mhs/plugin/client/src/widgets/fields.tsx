/**
 * One field, read-only (mhs-ui-design section 8): a gauge for a number with a range, a number card
 * without one, a light for a boolean, a tag for an enum or text. Alert levels colour it; a field
 * of a values source opens its two-minute trend.
 */
import { useState } from 'react'
import { alertOf } from '../core/describe.js'
import type { Field } from '../core/types.js'
import { t, valueText, word } from '../i18n/i18n.js'
import { useSamples } from '../react/hooks.js'

export function fieldLabel(name: string, field: Field | undefined): string {
  if (field?.ui?.label) return field.ui.label
  // A consumable is named by what it is (propellant, oxygen), not by the role.
  if (field?.role === 'consumable') return field.of ?? name
  if (field?.role && !field.role.startsWith('x_')) {
    const role = word('role', field.role, name)
    return field.of ? `${field.of} ${role.toLowerCase()}` : role
  }
  return name
}

export function FieldView(props: {
  name: string
  field: Field | undefined
  value: unknown
  /** `device/source` when the field belongs to a values source with a trend. */
  trend?: [string, string]
}) {
  const { name, field, value } = props
  const [open, setOpen] = useState(false)
  const alert = alertOf(field, value)
  const label = fieldLabel(name, field)
  const ranged = typeof value === 'number' && field?.min !== undefined && field.max !== undefined
  let body = <span className="mhs-field-value">{valueText(value, field?.unit)}</span>
  if (ranged) {
    const min = field.min as number
    const max = field.max as number
    const pct = Math.max(0, Math.min(1, ((value as number) - min) / (max - min || 1)))
    const marks = [field.alert?.warn, field.alert?.bad].filter((m): m is number => m !== undefined)
    body = (
      <>
        <span className="mhs-field-value">{valueText(value, field.unit)}</span>
        <span className="mhs-gauge">
          <span style={{ width: `${pct * 100}%` }} />
          {marks.map((m) => (
            <i key={m} style={{ left: `${((m - min) / (max - min || 1)) * 100}%` }} />
          ))}
        </span>
      </>
    )
  } else if (typeof value === 'boolean') {
    body = (
      <span className="mhs-field-value">
        <span className="mhs-light" data-on={value} /> {value ? 'on' : 'off'}
      </span>
    )
  } else if (typeof value === 'string' && field?.enum) {
    body = <span className="mhs-tag">{value}</span>
  } else if (typeof value === 'string') {
    // Free text is read, not scanned like a number: smaller, cut to its box, whole on hover.
    body = (
      <span className="mhs-field-value mhs-field-text" title={value}>
        {value}
      </span>
    )
  }
  const canTrend = props.trend && typeof value === 'number'
  return (
    <div className="mhs-field" data-alert={alert} title={field?.description}>
      <button
        type="button"
        className="mhs-field-label"
        disabled={!canTrend}
        onClick={() => setOpen(!open)}
        aria-expanded={canTrend ? open : undefined}
      >
        {label}
      </button>
      {body}
      {open && props.trend && (
        <Trend device={props.trend[0]} source={props.trend[1]} field={name} unit={field?.unit} />
      )}
    </div>
  )
}

/** A sparkline of the last two minutes, one sample a second. */
export function Trend(props: { device: string; source: string; field: string; unit?: string | undefined }) {
  const samples = useSamples(props.device, props.source, props.field)
  if (samples.length < 2) return <div className="mhs-note">{t('data.noTrend')}</div>
  const values = samples.map((s) => s.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const t0 = samples[0]?.time ?? 0
  const span = Math.max(1, (samples[samples.length - 1]?.time ?? 1) - t0)
  const points = samples
    .map((s) => `${((s.time - t0) / span) * 100},${30 - ((s.value - lo) / (hi - lo || 1)) * 28 - 1}`)
    .join(' ')
  return (
    <div className="mhs-trend">
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-label={t('data.trend')}>
        <polyline points={points} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="mhs-trend-range">
        {valueText(lo, props.unit)} – {valueText(hi, props.unit)}
      </span>
    </div>
  )
}
