import { message } from 'antd'
import { createContext, type HTMLAttributes, useContext, useEffect, useId, useRef } from 'react'
import { Icon } from './icon.js'

export type ToastProps = HTMLAttributes<HTMLDivElement> & {
  open: boolean
  onDismiss(): void
  duration?: number
  tone?: 'success' | 'info' | 'error'
}
type ToastTone = NonNullable<ToastProps['tone']>
const toneIcon = { success: 'circle-check', info: 'info', error: 'circle-alert' } as const
const ToastContent = createContext<HTMLAttributes<HTMLDivElement> & { tone: ToastTone }>({ tone: 'success' })
function ToastBody() {
  const { children, className, tone, ...props } = useContext(ToastContent)
  return (
    <div
      {...props}
      role="status"
      aria-live="polite"
      className={['agh-toast', className].filter(Boolean).join(' ')}
    >
      <Icon name={toneIcon[tone]} className="agh-toast-icon" />
      <span className="agh-toast-text">{children}</span>
    </div>
  )
}
/** Context-bound antd message; outcome classes preserve the existing success/info/error colours. */
export function Toast({
  open,
  onDismiss,
  duration = 3000,
  tone = 'success',
  children,
  className,
  ...props
}: ToastProps) {
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
      duration: 0,
      icon: null,
      role: 'presentation',
      onClose: finish,
      content: <ToastBody />,
    }
    api.open(notice)
    const timer = duration > 0 ? setTimeout(finish, duration) : undefined
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish()
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      active = false
      clearTimeout(timer)
      api.destroy(id)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open, duration, api, id])
  return (
    <ToastContent.Provider
      value={{
        ...props,
        tone,
        className: [tone !== 'success' && `agh-toast--${tone}`, className].filter(Boolean).join(' '),
        children,
      }}
    >
      <div ref={host} className="agh-toast-host">
        {holder}
      </div>
    </ToastContent.Provider>
  )
}
