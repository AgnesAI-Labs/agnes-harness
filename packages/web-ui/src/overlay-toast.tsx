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
      const modal = owner.querySelector<HTMLElement>('dialog[open]') ?? owner.activeElement
      setContainer(getOverlayContainer(modal instanceof HTMLElement ? modal : anchor.current, owner))
    }
  }, [props.open])
  return (
    <>
      <span ref={anchor} hidden data-agnes-overlay-anchor="notification" />
      {container && createPortal(<PrimitiveToast {...props} />, container)}
    </>
  )
}
