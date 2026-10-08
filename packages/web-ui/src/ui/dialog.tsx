import { Modal as AntModal, type ModalProps as AntModalProps } from 'antd'

export type DialogProps = AntModalProps

export function Dialog({ className, ...props }: DialogProps) {
  const classes = ['agnes-ui-dialog', className].filter(Boolean).join(' ')
  // Keep confirmations inside the caller's native dialog top layer.
  return (
    <AntModal
      getContainer={false}
      {...props}
      className={classes}
      onCancel={(event) => {
        event.preventDefault()
        props.onCancel?.(event)
      }}
    />
  )
}
