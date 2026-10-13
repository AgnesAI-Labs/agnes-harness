import { Select as AntSelect, type SelectProps as AntSelectProps } from 'antd'
import { useState } from 'react'

export type SelectProps<ValueType = unknown> = AntSelectProps<ValueType>

export function Select<ValueType = unknown>({ className, ...props }: SelectProps<ValueType>) {
  const [popupOpen, setPopupOpen] = useState(false)
  const classes = ['agnes-ui-select', className].filter(Boolean).join(' ')
  // A plain select is a popup button: it picks one of a set, so it ends in the up/down block.
  // A searchable or multiple select is a field and keeps the library's affordance.
  const popupButton = !props.showSearch && !props.mode
  return (
    <AntSelect<ValueType>
      {...(popupButton
        ? {
            suffixIcon: <span className="agh-popup-chevrons" aria-hidden="true" />,
          }
        : {})}
      {...props}
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
