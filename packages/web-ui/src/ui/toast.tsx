import { message } from 'antd'
import { createContext, type HTMLAttributes, useContext, useEffect, useId, useRef } from 'react'

export type ToastProps = HTMLAttributes<HTMLDivElement> & {
  open: boolean
  onDismiss(): void
  duration?: number
}
const ToastContent = createContext<HTMLAttributes<HTMLDivElement>>({})
function ToastBody() {
  const { children, className, ...props } = useContext(ToastContent)
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
/** Context-bound antd message; outcome classes preserve the existing success/info/error colours. */
export function Toast({ open, onDismiss, duration = 3000, children, className, ...props }: ToastProps) {
  const host = useRef<HTMLDivElement>(null)
  const dismiss = useRef(onDismiss)
  const id = useId()
  dismiss.current = onDismiss
  const [api, holder] = message.useMessage({
    getContainer: () => host.current ?? document.body,
    pauseOnHover: false,
  })
  useEffect(() => {
    if (!open) return
    let active = true
    const finish = () => {
      if (!active) return
      active = false
      api.destroy(id)
      dismiss.current()
    }
    // The pinned message hook forwards notice attributes; content owns the sole polite live region.
    const notice = {
      key: id,
      duration: duration / 1000,
      icon: null,
      role: 'presentation',
      onClose: finish,
      content: <ToastBody />,
    }
    api.open(notice)
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish()
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      active = false
      api.destroy(id)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, duration, api, id])
  return (
    <ToastContent.Provider value={{ ...props, className, children }}>
      <div ref={host} className="agh-toast-host">
        {holder}
      </div>
    </ToastContent.Provider>
  )
}
