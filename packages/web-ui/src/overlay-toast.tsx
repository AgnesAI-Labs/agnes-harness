import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getOverlayContainer } from './overlay-policy.js'
import { Toast as PrimitiveToast, type ToastProps } from './ui/toast.js'

export type { ToastProps } from './ui/toast.js'

/** Keep the primitive's context-bound holder in the application's active overlay/focus scope. */
export function Toast(props: ToastProps) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [container, setContainer] = useState<HTMLElement>()
  useLayoutEffect(() => {
    if (!props.open) return
    if (anchor.current) {
      const owner = anchor.current.ownerDocument
      // A toast is a page-level overlay, so an open dialog is the only scope it must stay inside.
      // Resolving from the focused element instead hands it to a popover that is closing right as
      // the toast mounts — the action that raised it is often inside that popover — and the toast
      // disappears with its container.
      const modal = owner.querySelector<HTMLElement>('dialog[open]')
      setContainer(getOverlayContainer(modal ?? anchor.current, owner))
    }
  }, [props.open])
  return (
    <>
      <span ref={anchor} hidden data-agnes-overlay-anchor="notification" />
      {container && createPortal(<PrimitiveToast {...props} />, container)}
    </>
  )
}
