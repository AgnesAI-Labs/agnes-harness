/**
 * The small set of controls every page uses (mhs-ui-design 4.1): buttons, a toggle, a slider,
 * a select, inputs, segmented choice, and icons. They use only --mhs-* variables.
 */
import type { ReactNode } from 'react'

export function Button(props: {
  children: ReactNode
  onClick?: (() => void) | undefined
  kind?: 'plain' | 'primary' | 'danger' | 'ghost' | undefined
  small?: boolean | undefined
  disabled?: boolean | undefined
  title?: string | undefined
  type?: 'button' | 'submit' | undefined
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className={`mhs-btn mhs-btn-${props.kind ?? 'plain'}${props.small ? ' mhs-btn-sm' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

export function Toggle(props: {
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean | undefined
  label?: string | undefined
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      className="mhs-toggle"
      data-on={props.on}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
    >
      <span />
    </button>
  )
}

export function Slider(props: {
  value: number
  min: number
  max: number
  step?: number | undefined
  onChange: (v: number) => void
  onCommit?: ((v: number) => void) | undefined
  disabled?: boolean | undefined
}) {
  const step = props.step ?? niceStep(props.min, props.max)
  return (
    <span className="mhs-slider">
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onPointerUp={(e) => props.onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => props.onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
      <input
        type="number"
        className="mhs-input mhs-num"
        min={props.min}
        max={props.max}
        step={step}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onBlur={(e) => props.onCommit?.(Number(e.target.value))}
      />
    </span>
  )
}

export function niceStep(min: number, max: number, integer = false): number {
  const span = Math.abs(max - min)
  if (integer || span >= 100) return 1
  if (span >= 10) return 0.5
  if (span >= 1) return 0.1
  return 0.01
}

export function Select(props: {
  value: string
  options: string[]
  onChange: (v: string) => void
  disabled?: boolean | undefined
  placeholder?: string | undefined
}) {
  return (
    <select
      className="mhs-input mhs-select"
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.placeholder !== undefined && <option value="">{props.placeholder}</option>}
      {props.options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

export function Segmented(props: {
  value: string
  options: string[]
  onChange: (v: string) => void
  disabled?: boolean | undefined
}) {
  return (
    <span className="mhs-seg">
      {props.options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={props.value === o}
          className="mhs-seg-item"
          data-on={props.value === o}
          disabled={props.disabled}
          onClick={() => props.onChange(o)}
        >
          {o}
        </button>
      ))}
    </span>
  )
}

export function TextInput(props: {
  value: string
  onChange: (v: string) => void
  onCommit?: ((v: string) => void) | undefined
  disabled?: boolean | undefined
  placeholder?: string | undefined
  maxLength?: number | undefined
  multiline?: boolean | undefined
}) {
  if (props.multiline)
    return (
      <textarea
        className="mhs-input mhs-textarea"
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={(e) => props.onCommit?.(e.target.value)}
      />
    )
  return (
    <input
      className="mhs-input"
      value={props.value}
      disabled={props.disabled}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={(e) => props.onCommit?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') props.onCommit?.((e.target as HTMLInputElement).value)
      }}
    />
  )
}

export function Dot(props: { tone: string; title?: string }) {
  return <span className="mhs-dot" data-tone={props.tone} title={props.title} />
}

export function Bar(props: { done: number; total: number }) {
  const pct = props.total > 0 ? Math.max(0, Math.min(1, props.done / props.total)) : 0
  return (
    <span className="mhs-bar">
      <span style={{ width: `${pct * 100}%` }} />
    </span>
  )
}

const ICONS: [RegExp, ReactNode][] = [
  [
    /heli|drone|uav|copter|quad/,
    <>
      <path d="M2 4h12M8 4v3" />
      <rect x="5" y="7" width="6" height="4" rx="2" />
      <path d="M6 13h4" />
    </>,
  ],
  [
    /rover|car|cart|vehicle|truck|robot|mover|base_?unit/,
    <>
      <rect x="2.5" y="5" width="11" height="5" rx="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11" cy="12" r="1.5" />
    </>,
  ],
  [/dog|quadruped|legged/, <path d="M3 6h8l2-2v4l-2 1H5l-1 5M11 9l1 5M5 9l-2 5" />],
  [/arm|manipulator/, <path d="M3 14h5M5 14l1-5 5-3 2 2M11 6l2-3" />],
  [
    /camera|cam\b|cam-|cam_/,
    <>
      <rect x="2" y="5" width="9" height="7" rx="1.5" />
      <path d="M11 8l3-2v5l-3-2" />
    </>,
  ],
  [
    /sensor|weather|env|meter|probe/,
    <path d="M8 2v8M5.5 12.5a2.5 2.5 0 1 0 5 0c0-1-.6-1.8-1.5-2.2V2.8a1 1 0 0 0-2 0v7.5c-.9.4-1.5 1.2-1.5 2.2z" />,
  ],
  [/lamp|light|bulb/, <path d="M6 13h4M6.5 11h3M8 2a4 4 0 0 0-2 7.5V11h4V9.5A4 4 0 0 0 8 2z" />],
  [
    /antenna|comms|radio|link|relay/,
    <path d="M8 7v7M5 14h6M5 4a4 4 0 0 1 6 0M3 2a7 7 0 0 1 10 0M8 7a1 1 0 1 0 0-.1" />,
  ],
  [/lab|analy|chem|sample/, <path d="M6 2h4M7 2v4l-4 7h10l-4-7V2" />],
  [
    /suit|person|wear|human|crew/,
    <>
      <circle cx="8" cy="4" r="2" />
      <path d="M4 14v-3a4 4 0 0 1 8 0v3" />
    </>,
  ],
  [/door|airlock|lock|gate|hatch/, <path d="M4 14V2h8v12M3 14h10M10 8h.1" />],
  [/power|battery|solar|charger|grid/, <path d="M9 2L4 9h4l-1 5 5-7H8z" />],
  [/habitat|home|house|base|room/, <path d="M2 8l6-5 6 5M4 7v7h8V7" />],
]

/** A device icon from its `ui.icon` or its kind; a chip for anything unknown. */
export function KindIcon(props: { kind: string; icon?: string | undefined }) {
  const word = (props.icon ?? props.kind).toLowerCase()
  const found = ICONS.find(([re]) => re.test(word))?.[1] ?? (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2" />
    </>
  )
  return (
    <svg className="mhs-icon" viewBox="0 0 16 16" aria-hidden="true">
      {found}
    </svg>
  )
}

export function Chevron(props: { dir: 'left' | 'right' | 'down' | 'up' }) {
  const d = { left: 'M10 3L5 8l5 5', right: 'M6 3l5 5-5 5', down: 'M3 6l5 5 5-5', up: 'M3 10l5-5 5 5' }
  return (
    <svg className="mhs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={d[props.dir]} />
    </svg>
  )
}
