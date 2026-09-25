import { Modal as AntModal, type ModalProps as AntModalProps } from 'antd'

export type DialogProps = AntModalProps

export function Dialog({ className, ...props }: DialogProps) {
  const classes = ['agnes-ui-dialog', className].filter(Boolean).join(' ')
  return <AntModal {...props} className={classes} />
}
