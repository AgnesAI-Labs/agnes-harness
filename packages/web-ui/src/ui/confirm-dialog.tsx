import type { ReactNode } from 'react'
import { fallbackT } from '../locales/index.js'
import { Button } from './button.js'
import { Dialog, type DialogProps } from './dialog.js'

export type ConfirmDialogProps = Omit<
  DialogProps,
  'footer' | 'onOk' | 'onCancel' | 'okButtonProps' | 'cancelButtonProps'
> & {
  onConfirm(): void
  onCancel(): void
  confirmLabel?: ReactNode
  cancelLabel?: ReactNode
  destructive?: boolean
  busy?: boolean
}
/** One primary action. Enter confirms; Escape cancels; a busy operation refuses duplicate decisions. */
export function ConfirmDialog({
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  children,
  ...props
}: ConfirmDialogProps) {
  return (
    <Dialog
      size="sm"
      {...props}
      keyboard={!busy}
      closable={!busy && props.closable !== false}
      mask={{ closable: !busy }}
      onCancel={() => {
        if (!busy) onCancel()
      }}
      footer={
        <>
          <Button disabled={busy} onClick={onCancel}>
            {cancelLabel ?? fallbackT('ui.cancel')}
          </Button>
          <Button
            type="primary"
            danger={destructive}
            dangerFilled={destructive}
            loading={busy}
            onClick={onConfirm}
          >
            {confirmLabel ?? fallbackT('ui.confirm')}
          </Button>
        </>
      }
      modalRender={(node) => (
        <div
          role="group"
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.defaultPrevented &&
              !event.nativeEvent.isComposing &&
              !busy &&
              !(event.target as Element).closest(
                'button, textarea, [role="combobox"], [contenteditable="true"]',
              )
            ) {
              event.preventDefault()
              onConfirm()
            }
          }}
        >
          {props.modalRender ? props.modalRender(node) : node}
        </div>
      )}
    >
      {children}
    </Dialog>
  )
}
