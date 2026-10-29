import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getOverlayContainer } from '../overlay-policy.js'
import { IconButton } from './icon-button.js'

export type NotificationItem = Readonly<{ id: number; message: ReactNode }>
export type NotificationsProps = {
  items: readonly NotificationItem[]
  onDismiss(id: number): void
  closeLabel: string
  duration?: number
}
function Notification({
  item,
  onDismiss,
  closeLabel,
  duration,
}: NotificationsProps & { item: NotificationItem }) {
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    const close = () => dismiss.current(item.id)
    const timer = setTimeout(close, duration ?? 6000)
    // BFCache must not restore expired errors. Keep this listener for the next restored page too.
    window.addEventListener('pagehide', close)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pagehide', close)
    }
  }, [item.id, duration])
  return (
    <div className="agh-notification">
      <span role="alert" className="agh-notification-message">
        {item.message}
      </span>
      <IconButton name="x" label={closeLabel} onClick={() => onDismiss(item.id)} />
    </div>
  )
}
/** Independent, transient errors. The caller retains actionable and recovery banners. */
export function Notifications(props: NotificationsProps) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [container, setContainer] = useState<HTMLElement>()
  useLayoutEffect(() => {
    if (props.items.length && anchor.current)
      setContainer(getOverlayContainer(anchor.current, anchor.current.ownerDocument))
  }, [props.items.length])
  return (
    <>
      <span ref={anchor} hidden data-agnes-overlay-anchor="notification" />
      {container &&
        createPortal(
          <div className="agh-notifications">
            {props.items.map((item) => (
              <Notification key={item.id} {...props} item={item} />
            ))}
          </div>,
          container,
        )}
    </>
  )
}
