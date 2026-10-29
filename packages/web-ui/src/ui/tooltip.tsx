import { Tooltip as AntTooltip, type TooltipProps as AntTooltipProps } from 'antd'
import { cloneElement, type ReactElement, useId, useState } from 'react'
import { Kbd, type ShortcutKey } from './kbd.js'

export type TooltipProps = Omit<AntTooltipProps, 'children' | 'title' | 'open' | 'trigger' | 'disabled'> & {
  title: string
  children?: ReactElement<{ 'aria-describedby'?: string | undefined }>
  /** Disabled native controls need a keyboard-accessible explanation. */
  disabled?: boolean | undefined
  /** The action's keyboard shortcut, shown as keycaps after the title. */
  shortcut?: readonly ShortcutKey[] | undefined
}
// Focus moved by Tab or an arrow key reveals a hint; focus a closing dialog hands back to its trigger does not.
let keyNavigation = false
if (typeof document !== 'undefined') {
  document.addEventListener(
    'keydown',
    (event) => {
      keyNavigation =
        event.key === 'Tab' || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End'
    },
    true,
  )
  document.addEventListener('pointerdown', () => (keyNavigation = false), true)
}

/** Hover waits 500ms; keyboard navigation reveals the explanation immediately. */
export function Tooltip({ title, children, disabled = false, shortcut, ...props }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  if (!children) return null
  const expanded =
    'aria-expanded' in children.props &&
    (children.props['aria-expanded'] === true || children.props['aria-expanded'] === 'true')
  const visible = open && !expanded
  return (
    <AntTooltip
      {...props}
      align={
        props.align ?? {
          overflow: {
            adjustX: props.autoAdjustOverflow !== false,
            adjustY: props.autoAdjustOverflow !== false,
            shiftX: props.autoAdjustOverflow !== false,
            shiftY: props.autoAdjustOverflow !== false,
            ...(typeof props.autoAdjustOverflow === 'object' ? props.autoAdjustOverflow : {}),
          },
        }
      }
      id={id}
      title={
        shortcut ? (
          <span className="agh-tooltip-shortcut">
            {title}
            <Kbd keys={shortcut} />
          </span>
        ) : (
          title
        )
      }
      open={visible}
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
        onFocusCapture={() => setOpen(keyNavigation)}
        onBlurCapture={() => setOpen(false)}
        onClickCapture={() => setOpen(false)}
        onKeyDownCapture={(event) => {
          if (event.key === 'Escape' && open) {
            // Dismiss the hint without cancelling the surrounding modal's Escape behavior.
            setOpen(false)
          }
        }}
      >
        {cloneElement(children, {
          'aria-describedby':
            [children.props['aria-describedby'], visible && id].filter(Boolean).join(' ') || undefined,
        })}
      </span>
    </AntTooltip>
  )
}
