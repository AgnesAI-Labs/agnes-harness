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
  /** Refuse confirmation while keeping Cancel available, for example while a project is running. */
  confirmDisabled?: boolean
  /** Test ids of the two buttons, for pages whose ids predate the shared dialog. */
  testIds?: { confirm?: string; cancel?: string }
}
/** One primary action. Enter confirms; Escape cancels; a busy operation refuses duplicate decisions. */
export function ConfirmDialog({
  onConfirm,
  onCancel,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  confirmDisabled = false,
  testIds,
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
          <Button disabled={busy} onClick={onCancel} data-testid={testIds?.cancel}>
            {cancelLabel ?? fallbackT('ui.cancel')}
          </Button>
          <Button
            type="primary"
            danger={destructive}
            dangerFilled={destructive}
            disabled={busy || confirmDisabled}
            loading={busy}
            data-testid={testIds?.confirm}
            onClick={() => {
              if (!busy && !confirmDisabled) onConfirm()
            }}
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
              !confirmDisabled &&
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
