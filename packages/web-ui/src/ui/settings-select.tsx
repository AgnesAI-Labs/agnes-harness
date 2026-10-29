import { Children, forwardRef, isValidElement, type ReactNode, type SelectHTMLAttributes } from 'react'
import { fallbackT } from '../locales/index.js'

type DataAttributes = { [name: `data-${string}`]: string | number | boolean | undefined }

/** Native select preserves form semantics, following SettingsOptionSelect's account-dialog pattern. */
export const SettingsSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & DataAttributes & { readOnly?: boolean }
>(function SettingsSelect({ readOnly, ...props }, ref) {
  const options: { value: string; disabled: boolean }[] = []
  const collect = (children: ReactNode, groupDisabled = false) =>
    Children.forEach(children, (child) => {
      if (!isValidElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>(child))
        return
      if (child.type === 'option')
        options.push({
          value: String(child.props.value ?? child.props.children ?? ''),
          disabled: groupDisabled || !!child.props.disabled,
        })
      else if (child.props.children)
        collect(child.props.children, groupDisabled || (child.type === 'optgroup' && !!child.props.disabled))
    })
  collect(props.children)
  const value = props.value === undefined ? undefined : String(props.value)
  const selected = options.find((option) => option.value === value)
  const unavailable = !!value && (!selected || selected.disabled)
  return (
    <select
      {...props}
      ref={ref}
      aria-invalid={props['aria-invalid'] || unavailable || undefined}
      data-unavailable={unavailable || undefined}
      aria-readonly={readOnly || undefined}
      data-readonly={readOnly || undefined}
      onChange={(event) => {
        if (readOnly) {
          event.currentTarget.value = String(props.value ?? props.defaultValue ?? '')
          return
        }
        props.onChange?.(event)
      }}
      onMouseDown={(event) => {
        if (readOnly) {
          event.preventDefault()
          event.currentTarget.focus()
        }
        props.onMouseDown?.(event)
      }}
      onKeyDown={(event) => {
        if (readOnly && !['Tab', 'Escape'].includes(event.key)) event.preventDefault()
        props.onKeyDown?.(event)
      }}
      className={['agnes-settings-input', props.className].filter(Boolean).join(' ')}
    >
      {unavailable && !selected && (
        <option value={value} disabled>
          {value} · {fallbackT('ui.valueUnavailable')}
        </option>
      )}
      {props.children}
    </select>
  )
})
