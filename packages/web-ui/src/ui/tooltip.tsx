import { Tooltip as AntTooltip, type TooltipProps as AntTooltipProps } from 'antd'
import { cloneElement, type ReactElement, useId, useState } from 'react'

export type TooltipProps = Omit<AntTooltipProps, 'children' | 'title' | 'open' | 'trigger' | 'disabled'> & {
  title: string
  children?: ReactElement<{ 'aria-describedby'?: string | undefined }>
  /** Disabled native controls need a keyboard-accessible explanation. */
  disabled?: boolean | undefined
}
/** Hover waits 500ms; focus reveals the explanation immediately. */
export function Tooltip({ title, children, disabled = false, ...props }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!children) return null
  return (
    <AntTooltip
      {...props}
      motion={{ motionName: '' }}
      id={id}
      title={title}
      open={open}
      trigger="hover"
      mouseEnterDelay={0.5}
      onOpenChange={setOpen}
      rootClassName={['agh-tooltip', props.rootClassName].filter(Boolean).join(' ')}
    >
      <span
        className="agh-tooltip-anchor"
        role="group"
        tabIndex={disabled ? 0 : undefined}
        aria-label={disabled ? title : undefined}
        onFocusCapture={() => setOpen(true)}
        onBlurCapture={() => setOpen(false)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape' && open) {
            // Dismiss the hint without cancelling the surrounding modal's Escape behavior.
            setOpen(false)
          }
        }}
      >
        {cloneElement(children, {
          'aria-describedby':
            [children.props['aria-describedby'], open && id].filter(Boolean).join(' ') || undefined,
        })}
      </span>
    </AntTooltip>
  )
}
