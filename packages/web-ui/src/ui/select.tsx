import { Select as AntSelect, type SelectProps as AntSelectProps } from 'antd'
import { useState } from 'react'
import { fallbackT } from '../locales/index.js'

export type SelectProps<ValueType = unknown> = AntSelectProps<ValueType> & { readOnly?: boolean }

export function Select<ValueType = unknown>({ className, readOnly, ...props }: SelectProps<ValueType>) {
  const [popupOpen, setPopupOpen] = useState(false)
  const options = props.options
  const value = props.value
  const current = options
    ?.flatMap((option) => ('options' in option ? option.options : [option]))
    .find((option) => option.value === value)
  const unavailable =
    value !== undefined &&
    value !== null &&
    value !== '' &&
    !Array.isArray(value) &&
    options !== undefined &&
    (!current || current.disabled)
  const classes = ['agnes-ui-select', className].filter(Boolean).join(' ')
  // All selects use the same neutral down-chevron.
  const popupButton = !props.mode
  return (
    <AntSelect<ValueType>
      {...(popupButton
        ? {
            suffixIcon: <span className="agh-popup-chevrons" aria-hidden="true" />,
          }
        : {})}
      {...props}
      {...(unavailable && !current && (typeof value === 'string' || typeof value === 'number')
        ? {
            options: [
              { value, label: `${String(value)} · ${fallbackT('ui.valueUnavailable')}`, disabled: true },
              ...(options ?? []),
            ],
          }
        : {})}
      aria-invalid={props['aria-invalid'] || unavailable || undefined}
      {...(props.status ? { status: props.status } : unavailable ? { status: 'error' as const } : {})}
      data-unavailable={unavailable || undefined}
      data-readonly={readOnly || undefined}
      aria-readonly={readOnly || undefined}
      {...(readOnly ? { open: false } : {})}
      onChange={(...args) => {
        if (!readOnly) props.onChange?.(...args)
      }}
      className={classes}
      onOpenChange={(open) => {
        setPopupOpen(open)
        props.onOpenChange?.(open)
      }}
      onInputKeyDown={(event) => {
        if (event.key === 'Escape' && (props.open ?? popupOpen)) event.preventDefault()
        props.onInputKeyDown?.(event)
      }}
    />
  )
}
