import { forwardRef } from 'react'
import { Button, type ButtonProps } from './button.js'
import { Icon } from './icon.js'
import type { IconName } from './icons.js'
import { Tooltip } from './tooltip.js'

export type IconButtonProps = Omit<ButtonProps, 'children' | 'icon' | 'name' | 'aria-label'> & {
  name: IconName
  label: string
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { name, label, className, disabledReason, ...props },
  ref,
) {
  return (
    <Tooltip title={props.disabled && disabledReason ? disabledReason : label} disabled={props.disabled}>
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
