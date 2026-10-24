import type { JSX } from 'react'
import { ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog } from '../locales/admin.js'
import { useUiText } from '../ui-locale.js'

/** Semantic tones. Keep colors out of JS: pass only `data-tone`, with colors determined by style.css tokens. */
export type StateTone = 'ok' | 'warn' | 'off' | 'bad' | 'unknown'

export type StateLight = Readonly<{
  /** What this cell represents: trust / desired / actual. */
  label: string
  /** This cell's value, translated into readable text. */
  value: string
  tone: StateTone
}>

/**
 * Status light row. The DOM contract matches style.css `.state-lights`: lights are decorative,
 * dots are aria-hidden, and full semantics remain in `title` and visible text for screen readers.
 */
export function StateLights({ states }: { states: readonly StateLight[] }): JSX.Element {
  const { t } = useUiText(ADMIN_LOCALE_NAMESPACE, adminLocaleCatalog)
  return (
    <div className="state-lights">
      {states.map((state) => (
        <span
          key={state.label}
          className="state-light"
          data-tone={state.tone}
          title={t('state.title', { label: state.label, value: state.value })}
        >
          <span className="state-light-dot" aria-hidden="true" />
          <span className="state-light-copy">
            <span className="state-light-name">{state.label}</span>
            <span className="state-light-value">{state.value}</span>
          </span>
        </span>
      ))}
    </div>
  )
}

export type StateSwitchProps = Readonly<{
  /** Accessible name, such as Enable GitHub. */
  label: string
  id?: string | undefined
  testId?: string | undefined
  invalid?: boolean | undefined
  describedBy?: string | undefined
  checked: boolean
  busy?: boolean | undefined
  disabled: boolean
  /** Called when the user toggles. The caller owns confirmation and busy state; this component changes no state. */
  onToggle(next: boolean): void
}>

/**
 * Switch uses `role="switch"` rather than checkbox for list rows and boolean settings; the caller owns state.
 * The caller derives `checked` from the observable result; clicks request a change without optimistic visual updates.
 * Avoid antd Switch to preserve inline action semantics, title, stopPropagation and the `.switch` skin contract.
 */
export function StateSwitch({
  label,
  checked,
  busy,
  disabled,
  onToggle,
  id,
  testId,
  invalid,
  describedBy,
}: StateSwitchProps): JSX.Element {
  return (
    <button
      type="button"
      id={id}
      data-testid={testId}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-busy={busy || undefined}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        // The row also opens details; toggling must not open them as well.
        event.stopPropagation()
        if (disabled) return
        onToggle(!checked)
      }}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  )
}
