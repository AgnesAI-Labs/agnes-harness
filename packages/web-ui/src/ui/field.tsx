import {
  Children,
  cloneElement,
  isValidElement,
  type LabelHTMLAttributes,
  type ReactNode,
  useId,
} from 'react'
import { fallbackT } from '../locales/index.js'
import { Icon } from './icon.js'

type Control = {
  id?: string | undefined
  'aria-describedby'?: string | undefined
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' | undefined
  describedBy?: string | undefined
  invalid?: boolean | undefined
}
export type FieldProps = Omit<LabelHTMLAttributes<HTMLLabelElement>, 'children'> & {
  children?: ReactNode
  error?: ReactNode
  hint?: ReactNode
  label: ReactNode
  htmlFor?: string
  optional?: boolean
  optionalLabel?: string
}
export function Field({
  children,
  error,
  hint,
  label,
  htmlFor,
  optional = false,
  optionalLabel,
  ...props
}: FieldProps) {
  const generated = useId()
  const first = Children.toArray(children).find((child) => isValidElement<Control>(child) && child.props.id)
  const controlId = htmlFor ?? (isValidElement<Control>(first) ? first.props.id : undefined) ?? generated
  const failed = error !== undefined && error !== null && error !== false && error !== ''
  const message = failed ? error : hint
  const hasMessage = message !== undefined && message !== null && message !== false && message !== ''
  const ownId = isValidElement<{ id?: string }>(message) ? message.props.id : undefined
  const messageId = ownId ?? `${generated}-message`
  const hintId = isValidElement<{ id?: string }>(hint) ? hint.props.id : undefined
  const controls = Children.map(children, (child) => {
    if (!isValidElement<Control>(child)) return child
    // Layout wrappers keep their own contract; direct controls and component controls accept ARIA.
    if (typeof child.type === 'string' && !['input', 'textarea', 'select', 'button'].includes(child.type))
      return child
    const described =
      [
        ...new Set(
          [child.props['aria-describedby'], child.props.describedBy, hasMessage ? messageId : undefined]
            .filter(Boolean)
            .join(' ')
            .split(' ')
            .filter((name) => name && !(failed && hintId && name === hintId)),
        ),
      ].join(' ') || undefined
    return cloneElement(child, {
      id: child.props.id ?? controlId,
      'aria-describedby': described,
      'aria-invalid': failed || child.props['aria-invalid'] || undefined,
      ...('describedBy' in child.props
        ? { describedBy: described, invalid: failed || child.props.invalid }
        : {}),
    })
  })
  return (
    <label
      {...props}
      className={['agnes-ui-field', 'agh-field', props.className].filter(Boolean).join(' ')}
      htmlFor={controlId}
    >
      <span className="agnes-ui-field-label">
        {label}
        {optional && <span className="agh-field-optional"> {optionalLabel ?? fallbackT('ui.optional')}</span>}
      </span>
      {controls}
      {hasMessage && (
        <span
          id={ownId ? undefined : messageId}
          className={failed ? 'agnes-ui-field-error' : 'agnes-ui-field-hint'}
          role={failed ? 'alert' : undefined}
        >
          {failed && <Icon name="circle-alert" />}
          {message}
        </span>
      )}
    </label>
  )
}
