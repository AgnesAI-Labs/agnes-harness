import { Modal as AntModal, type ModalProps as AntModalProps } from 'antd'
import { useEscapeCompositionLock, useOverlayFocus, useReducedMotion } from './overlay.js'
import { SheetHandle } from './sheet-handle.js'

export type DialogProps = AntModalProps & { size?: 'sm' | 'md' | 'lg' }

export function Dialog({ className, size = 'md', ...props }: DialogProps) {
  useOverlayFocus(props.open === true)
  const reduce = useReducedMotion()
  const compositionLocked = useEscapeCompositionLock()
  const classes = ['agnes-ui-dialog', 'agh-dialog', `agh-dialog--${size}`, className]
    .filter(Boolean)
    .join(' ')
  // Keep confirmations inside the caller's native dialog top layer.
  return (
    <AntModal
      getContainer={false}
      width={{ sm: 420, md: 560, lg: 720 }[size]}
      keyboard
      focusable={{ trap: true, focusTriggerAfterClose: false }}
      {...props}
      wrapProps={{
        ...props.wrapProps,
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
          props.wrapProps?.onKeyDown?.(event)
          if (
            event.key !== 'Escape' ||
            event.defaultPrevented ||
            compositionLocked(event.nativeEvent) ||
            props.open !== true ||
            props.keyboard === false
          )
            return
          const target = event.target as Element
          // Closed popups can retain antd's global Escape stack during their exit motion.
          // The modal containing keyboard focus owns an unconsumed Escape immediately.
          if (target.closest('[role="dialog"]') !== event.currentTarget.querySelector('[role="dialog"]'))
            return
          event.preventDefault()
          event.stopPropagation()
          props.onCancel?.(event)
        },
      }}
      {...(reduce ? { transitionName: '', maskTransitionName: '' } : {})}
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
        if (props.open !== true) return
        event.preventDefault()
        props.onCancel?.(event)
      }}
    />
  )
}
