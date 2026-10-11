import { type HTMLAttributes, useEffect, useRef } from 'react'

export type ToastProps = HTMLAttributes<HTMLDivElement> & {
  open: boolean
  onDismiss(): void
  duration?: number
}
/** A nonmodal, three-second success announcement; it never takes keyboard focus. */
export function Toast({ open, onDismiss, duration = 3000, children, className, ...props }: ToastProps) {
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => dismiss.current(), duration)
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss.current()
    }
    document.addEventListener('keydown', escape)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', escape)
    }
  }, [open, duration])
  if (!open) return null
  return (
    <div
      {...props}
      role="status"
      aria-live="polite"
      className={['agh-toast', className].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  )
}
