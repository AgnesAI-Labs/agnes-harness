import { type ReactNode, useId } from 'react'

export type SegmentedOption<Value extends string = string> = {
  value: Value
  label: ReactNode
  disabled?: boolean
  testId?: string
}
export type SegmentedProps<Value extends string = string> = {
  /** Names the group for assistive tech; the visible row label usually says the same. */
  label: string
  value: Value
  options: readonly SegmentedOption<Value>[]
  onChange(value: Value): void
  disabled?: boolean
  /** Stretch across the available width with equal segments. */
  block?: boolean
  /** Radio group name; defaults to a generated one. */
  name?: string
  id?: string
  testId?: string
  className?: string
}

/**
 * Two to six short, mutually exclusive choices. The segments are native radios, so the group keeps
 * arrow-key movement, form semantics and one tab stop; use a Select beyond six choices.
 */
export function Segmented<Value extends string = string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  block = false,
  name,
  id,
  testId,
  className,
}: SegmentedProps<Value>) {
  const generated = useId()
  const group = name ?? generated
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      id={id}
      data-testid={testId}
      data-block={block || undefined}
      className={['agh-segmented', className].filter(Boolean).join(' ')}
    >
      {options.map((option) => (
        <label key={option.value} className="agh-segmented-option">
          <input
            type="radio"
            name={group}
            value={option.value}
            checked={option.value === value}
            disabled={disabled || option.disabled}
            data-testid={option.testId}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}
