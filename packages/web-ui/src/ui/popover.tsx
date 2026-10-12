import { Popover as AntPopover, type PopoverProps } from 'antd'
import { cloneElement, type HTMLAttributes, isValidElement, useState } from 'react'
import { useOverlayFocus } from './overlay.js'

/** Anchored surfaces are nonmodal: Escape returns focus; Tab retains natural navigation. */
export function Popover({ content, children, onOpenChange, ...props }: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(props.defaultOpen ?? false)
  const open = props.open ?? internalOpen
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
      rootClassName={['agnes-ui-popover', props.rootClassName].filter(Boolean).join(' ')}
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
