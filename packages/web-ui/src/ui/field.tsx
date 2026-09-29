import type { LabelHTMLAttributes, ReactNode } from 'react'

export type FieldProps = Omit<LabelHTMLAttributes<HTMLLabelElement>, 'children'> & {
  children?: ReactNode
  error?: ReactNode
  hint?: ReactNode
  label: ReactNode
  htmlFor?: string
}

export function Field({ children, error, hint, label, htmlFor, ...props }: FieldProps) {
  return (
    <label
      {...props}
      className={['agnes-ui-field', props.className].filter(Boolean).join(' ')}
      htmlFor={htmlFor}
    >
      <span className="agnes-ui-field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="agnes-ui-field-hint">{hint}</span>}
      {error !== undefined && (
        <span className="agnes-ui-field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  )
}
