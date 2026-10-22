import { type ComponentPropsWithoutRef, type ReactNode, useId, useLayoutEffect, useRef } from 'react'

import { createSelectPicker, type SelectPicker } from '../select-picker.js'
import { SettingsSelect } from './settings-select.js'

export type SettingsPickerSelectProps = ComponentPropsWithoutRef<typeof SettingsSelect> & {
  /** The picker's accessible name; the row's visible label. */
  label: string
  children?: ReactNode
}

/**
 * A settings select with the themed picker over it. The native select stays the form control, so
 * values, change events and keyboard form semantics are unchanged; the picker only replaces the
 * platform menu. Callers without an id get one for the trigger.
 */
export function SettingsPickerSelect({ label, children, id, ...props }: SettingsPickerSelectProps) {
  const generated = useId()
  const selectId = id ?? generated
  const select = useRef<HTMLSelectElement>(null)
  const picker = useRef<SelectPicker>()
  useLayoutEffect(() => {
    if (!select.current) return
    const created = createSelectPicker(select.current, { label })
    picker.current = created
    return () => {
      picker.current = undefined
      created.destroy()
    }
  }, [label])
  // The picker mirrors the select, so it is brought up to date after every render.
  useLayoutEffect(() => picker.current?.sync())
  return (
    <SettingsSelect {...props} id={selectId} ref={select}>
      {children}
    </SettingsSelect>
  )
}
