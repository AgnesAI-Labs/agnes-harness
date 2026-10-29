import { Button as AntButton, type ButtonProps as AntButtonProps } from 'antd'
import { forwardRef } from 'react'
import { Tooltip } from './tooltip.js'

export type ButtonAppearance = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
export type ButtonProps = AntButtonProps & {
  appearance?: ButtonAppearance
  /** Only for the confirming action in a destructive dialog. */
  dangerFilled?: boolean
  /** Explain a disabled action; rendered through the shared tooltip. */
  disabledReason?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, children, appearance, dangerFilled = false, disabledReason, ...props },
  ref,
) {
  const tone =
    appearance ??
    (props.danger || props.color === 'danger'
      ? 'danger'
      : props.type === 'primary' || props.color === 'primary'
        ? 'primary'
        : props.type === 'link' || props.variant === 'link'
          ? 'link'
          : props.type === 'text' || props.variant === 'text' || props.ghost
            ? 'ghost'
            : 'secondary')
  const busy = Boolean(props.loading)
  const classes = [
    'agnes-ui-button',
    'agh-btn',
    `agh-btn--${tone}`,
    props.size === 'small' ? 'agh-btn--sm' : 'agh-btn--md',
    tone === 'danger' && dangerFilled && 'agh-btn--danger-filled',
    busy && !props.icon && 'agh-btn--loading-no-icon',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const button = (
    // Preserve Ant's public props/ref while contract CSS owns the presentation.
    <AntButton
      ref={ref}
      autoInsertSpace={false}
      {...props}
      aria-busy={busy || props['aria-busy']}
      title={props.disabled ? (disabledReason ?? props.title) : props.title}
      className={classes}
    >
      {children}
    </AntButton>
  )
  return props.disabled && disabledReason ? (
    <Tooltip title={disabledReason} disabled>
      {button}
    </Tooltip>
  ) : (
    button
  )
})
