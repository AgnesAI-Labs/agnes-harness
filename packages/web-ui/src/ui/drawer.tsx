import { Drawer as AntDrawer, type DrawerProps as AntDrawerProps } from 'antd'
import { type ReactNode, useId } from 'react'
import { fallbackT } from '../locales/index.js'
import { IconButton } from './icon-button.js'
import { useEscapeCompositionLock, useOverlayFocus } from './overlay.js'

export type DrawerProps = Omit<AntDrawerProps, 'title' | 'onClose'> & {
  onCancel?: AntDrawerProps['onClose']
  open: boolean
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  onClose(): void
  closeLabel?: string
}
/** Modal detail surface. Close competing native modal hosts before opening. */
export function Drawer({
  open,
  title,
  description,
  footer,
  onClose,
  closeLabel,
  children,
  className,
  onCancel,
  ...props
}: DrawerProps) {
  const id = useId()
  useOverlayFocus(open)
  const compositionLocked = useEscapeCompositionLock()
  return (
    <AntDrawer
      {...props}
      open={open}
      placement="right"
      size="min(480px, 100vw)"
      keyboard={props.keyboard !== false}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      focusable={{ trap: true, focusTriggerAfterClose: false }}
      destroyOnHidden
      rootClassName="agh-drawer-layer"
      className={['agh-drawer', className].filter(Boolean).join(' ')}
      closable={false}
      title={
        <div className="agh-drawer-heading">
          <div>
            <h2 id={`${id}-title`}>{title}</h2>
            {description && <p id={`${id}-description`}>{description}</p>}
          </div>
          <IconButton name="x" label={closeLabel ?? fallbackT('ui.close')} onClick={onClose} />
        </div>
      }
      footer={footer}
      onClose={(event) => {
        event.preventDefault()
        if ('key' in event && event.key === 'Escape') onCancel?.(event)
        onClose()
      }}
      onKeyDown={(event) => {
        props.onKeyDown?.(event)
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          compositionLocked(event.nativeEvent) ||
          !open ||
          props.keyboard === false
        )
          return
        const target = event.target as Element
        // A closing child portal must not delay Escape in the drawer now holding focus.
        const scope = event.currentTarget.matches('[role="dialog"]')
          ? event.currentTarget
          : event.currentTarget.querySelector('[role="dialog"]')
        if (target.closest('[role="dialog"]') !== scope) return
        event.preventDefault()
        event.stopPropagation()
        onCancel?.(event)
        onClose()
      }}
      drawerRender={(node) => <div className="agh-drawer-frame">{node}</div>}
    >
      <div className="agh-drawer-content">{children}</div>
    </AntDrawer>
  )
}
