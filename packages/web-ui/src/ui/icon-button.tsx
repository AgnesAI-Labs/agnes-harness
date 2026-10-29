import { forwardRef } from 'react'
import { Button, type ButtonProps } from './button.js'
import { Icon } from './icon.js'
import type { IconName } from './icon-set.js'
import type { ShortcutKey } from './kbd.js'
import { Tooltip } from './tooltip.js'

// `title` stays out: the Tooltip above already names the action, and a native
// title would pop a second, identical hint after the browser's own delay.
export type IconButtonProps = Omit<ButtonProps, 'children' | 'icon' | 'name' | 'aria-label' | 'title'> & {
  name: IconName
  label: string
  /** The action's keyboard shortcut, shown as keycaps after the label in the tooltip. */
  shortcut?: readonly ShortcutKey[]
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { name, label, className, disabledReason, shortcut, ...props },
  ref,
) {
  return (
    <Tooltip
      title={props.disabled && disabledReason ? disabledReason : label}
      shortcut={props.disabled && disabledReason ? undefined : shortcut}
      disabled={props.disabled}
    >
      <Button
        {...props}
        ref={ref}
        appearance={props.appearance ?? 'ghost'}
        size="small"
        aria-label={label}
        className={['agh-btn--icon', className].filter(Boolean).join(' ')}
        icon={<Icon name={name} size={18} />}
      />
    </Tooltip>
  )
})
