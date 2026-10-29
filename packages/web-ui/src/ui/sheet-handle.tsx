import { forwardRef, type MouseEvent, type PointerEvent, useRef } from 'react'
import { fallbackT } from '../locales/index.js'

/** Drag begins on the handle, leaving content scrolling and field gestures untouched. */
export const SheetHandle = forwardRef<
  HTMLButtonElement,
  {
    onDismiss(event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>): void
    label?: string
    /** The handle of a native dialog, which lays it out itself. */
    native?: boolean
  }
>(function SheetHandle({ onDismiss, label, native }, ref) {
  const start = useRef<number | undefined>(undefined)
  const dragged = useRef(false)
  return (
    <button
      ref={ref}
      type="button"
      className={native ? 'agh-sheet-handle agh-native-sheet-handle' : 'agh-sheet-handle'}
      aria-label={label ?? fallbackT('ui.close')}
      onPointerDown={(event) => {
        start.current = event.clientY
        dragged.current = false
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onPointerUp={(event) => {
        if (start.current !== undefined && event.clientY - start.current >= 80) {
          dragged.current = true
          onDismiss(event)
        }
        start.current = undefined
      }}
      onPointerCancel={() => {
        start.current = undefined
      }}
      onClick={(event) => {
        if (!dragged.current || event.detail === 0) onDismiss(event)
        dragged.current = false
      }}
    >
      <span aria-hidden="true" />
    </button>
  )
})
