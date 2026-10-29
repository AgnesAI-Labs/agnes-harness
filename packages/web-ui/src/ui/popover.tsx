import { Popover as AntPopover, type PopoverProps } from 'antd'
import { cloneElement, type HTMLAttributes, isValidElement, useMemo, useState } from 'react'
import { useOverlayFocus } from './overlay.js'

/** Anchored surfaces are nonmodal: Escape returns focus; Tab retains natural navigation. */
export function Popover({ content, children, onOpenChange, ...props }: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(props.defaultOpen ?? false)
  const open = props.open ?? internalOpen
  // A change of input device inside an open surface must not restart its entrance animation.
  const transition = useMemo(
    () => ({
      open,
      input:
        typeof document !== 'undefined' &&
        document.documentElement.getAttribute('data-agnes-input') === 'pointer'
          ? 'pointer'
          : 'keyboard',
    }),
    [open],
  )
  const restoreFocus = useOverlayFocus(open, false)
  const change = (next: boolean) => {
    setInternalOpen(next)
    onOpenChange?.(next)
  }
  return (
    <AntPopover
      {...props}
      open={open}
      onOpenChange={change}
      content={
        <div
          role="group"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) {
              event.preventDefault()
              event.stopPropagation()
              change(false)
              restoreFocus()
            }
          }}
        >
          {typeof content === 'function' ? content() : content}
        </div>
      }
      rootClassName={['agnes-ui-popover', `agnes-ui-popover--${transition.input}`, props.rootClassName]
        .filter(Boolean)
        .join(' ')}
    >
      {isValidElement<HTMLAttributes<HTMLElement>>(children)
        ? cloneElement(children, {
            onKeyDown: (event) => {
              children.props.onKeyDown?.(event)
              if (open && event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault()
                event.stopPropagation()
                change(false)
                restoreFocus()
              }
            },
          })
        : children}
    </AntPopover>
  )
}
