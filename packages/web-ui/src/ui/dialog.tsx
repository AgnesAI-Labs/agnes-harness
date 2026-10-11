import { Modal as AntModal, type ModalProps as AntModalProps } from 'antd'
import { SheetHandle } from './sheet-handle.js'

export type DialogProps = AntModalProps & { size?: 'sm' | 'md' | 'lg' }

export function Dialog({ className, size = 'md', ...props }: DialogProps) {
  const classes = ['agnes-ui-dialog', 'agh-dialog', `agh-dialog--${size}`, className]
    .filter(Boolean)
    .join(' ')
  // Keep confirmations inside the caller's native dialog top layer.
  return (
    <AntModal
      getContainer={false}
      width={{ sm: 420, md: 560, lg: 720 }[size]}
      {...props}
      className={classes}
      modalRender={(node) => (
        <>
          {props.closable !== false && (
            <SheetHandle
              onDismiss={(event) => {
                event.preventDefault()
                props.onCancel?.(event)
              }}
            />
          )}
          {props.modalRender ? props.modalRender(node) : node}
        </>
      )}
      onCancel={(event) => {
        event.preventDefault()
        props.onCancel?.(event)
      }}
    />
  )
}
