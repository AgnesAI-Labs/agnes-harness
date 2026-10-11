import { type MouseEvent, type PointerEvent, useRef } from 'react'
import { fallbackT } from '../locales/index.js'

/** Drag begins on the handle, leaving content scrolling and field gestures untouched. */
export function SheetHandle({
  onDismiss,
  label,
}: {
  onDismiss(event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>): void
  label?: string
}) {
  const start = useRef<number | undefined>(undefined)
  const dragged = useRef(false)
  return (
    <button
      type="button"
      className="agh-sheet-handle"
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
        if (!dragged.current) onDismiss(event)
      }}
    >
      <span aria-hidden="true" />
    </button>
  )
}
