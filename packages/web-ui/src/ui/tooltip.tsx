import { Tooltip as AntTooltip, type TooltipProps as AntTooltipProps } from 'antd'
import { cloneElement, type ReactElement, type ReactNode, useId, useRef, useState } from 'react'
import { Kbd, type ShortcutKey } from './kbd.js'

export type TooltipProps = Omit<AntTooltipProps, 'children' | 'title' | 'open' | 'trigger' | 'disabled'> & {
  /** A function is read when the hint opens, so a control toggled outside React explains itself late. */
  title: string | (() => ReactNode)
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
  const anchor = useRef<HTMLSpanElement>(null)
  if (!children) return null
  const text = () => (typeof title === 'function' ? title() : title)
  // A controller can enable a control after render; the hint follows the control, not the props.
  const explainsNothing = () => {
    const value = text()
    if (value === null || value === undefined || value === '') return true
    if (!disabled) return false
    const control = anchor.current?.querySelector<HTMLButtonElement>('button, input, select, textarea')
    return control ? !control.disabled : false
  }
  const reveal = (next: boolean) => setOpen(next && !explainsNothing())
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
        shortcut
          ? () => (
              <span className="agh-tooltip-shortcut">
                {text()}
                <Kbd keys={shortcut} />
              </span>
            )
          : text
      }
      open={visible}
      trigger="hover"
      mouseEnterDelay={0.5}
      onOpenChange={reveal}
      rootClassName={['agh-tooltip', props.rootClassName].filter(Boolean).join(' ')}
    >
      <span
        ref={anchor}
        className="agh-tooltip-anchor"
        role="group"
        tabIndex={disabled ? 0 : undefined}
        aria-label={disabled && typeof title === 'string' ? title : undefined}
        onFocusCapture={() => reveal(keyNavigation)}
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
