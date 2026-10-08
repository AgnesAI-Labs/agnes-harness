import { Select as AntSelect, type SelectProps as AntSelectProps } from 'antd'
import { useState } from 'react'

export type SelectProps<ValueType = unknown> = AntSelectProps<ValueType>

export function Select<ValueType = unknown>({ className, ...props }: SelectProps<ValueType>) {
  const [popupOpen, setPopupOpen] = useState(false)
  const classes = ['agnes-ui-select', className].filter(Boolean).join(' ')
  return (
    <AntSelect<ValueType>
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
