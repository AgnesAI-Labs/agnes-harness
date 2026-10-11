import { type DialogHTMLAttributes, type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { fallbackT } from '../locales/index.js'
import { IconButton } from './icon-button.js'

export type DrawerProps = Omit<DialogHTMLAttributes<HTMLDialogElement>, 'title' | 'onClose'> & {
  open: boolean
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  onClose(): void
  closeLabel?: string
}
/** A native top-layer detail surface. Open it after closing any other modal host. */
export function Drawer({
  open,
  title,
  description,
  footer,
  onClose,
  closeLabel,
  children,
  className,
  ...props
}: DrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const restore = useRef<HTMLElement | null>(null)
  const id = useId()
  useEffect(() => {
    const node = dialog.current
    if (!node || !open) return
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    node.showModal()
    return () => {
      node.close()
      if (restore.current?.isConnected) restore.current.focus()
    }
  }, [open])
  if (!open) return null
  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: native dialog cancellation is the keyboard equivalent of backdrop dismissal.
    <dialog
      {...props}
      ref={dialog}
      className={['agh-drawer', className].filter(Boolean).join(' ')}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => {
        event.preventDefault()
        props.onCancel?.(event)
        onClose()
      }}
      onClick={(event) => {
        props.onClick?.(event)
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <header className="agh-drawer-heading">
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p id={`${id}-description`}>{description}</p>}
        </div>
        <IconButton name="x" label={closeLabel ?? fallbackT('ui.close')} onClick={onClose} />
      </header>
      <div className="agh-drawer-content">{children}</div>
      {footer && <footer className="agh-dialog-footer">{footer}</footer>}
    </dialog>,
    document.body,
  )
}
