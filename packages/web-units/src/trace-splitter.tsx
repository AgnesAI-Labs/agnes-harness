import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { traceText } from './trace-locale.js'

export const TRACE_INSPECTOR_WIDTH_KEY = 'agnes.web.traceInspectorWidth'
export const TRACE_INSPECTOR_DEFAULT_WIDTH = 440
const MIN_WIDTH = 320
const MAX_SHARE = 0.7
const KEY_STEP = 16

/** The inspector is never narrower than 320px nor wider than 70% of the space it shares with the list. */
export function clampInspectorWidth(width: number, available: number): number {
  const max = Math.max(MIN_WIDTH, Math.floor(available * MAX_SHARE))
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)))
}

// Storage can be missing or throw (private windows, blocked site data); the width is a convenience.
const storage = (): Storage | undefined => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
const readWidth = (): number | undefined => {
  try {
    const value = Number(storage()?.getItem(TRACE_INSPECTOR_WIDTH_KEY))
    return Number.isFinite(value) && value >= MIN_WIDTH ? value : undefined
  } catch {
    return undefined
  }
}
const writeWidth = (value: number | undefined): void => {
  try {
    if (value === undefined) storage()?.removeItem(TRACE_INSPECTOR_WIDTH_KEY)
    else storage()?.setItem(TRACE_INSPECTOR_WIDTH_KEY, String(value))
  } catch {}
}

/** The inspector width this browser remembers, with a setter that keeps it and a reset. */
export function useInspectorWidth() {
  const [width, setWidth] = useState(() => readWidth() ?? TRACE_INSPECTOR_DEFAULT_WIDTH)
  return {
    width,
    set(next: number) {
      setWidth(next)
      writeWidth(next)
    },
    reset() {
      setWidth(TRACE_INSPECTOR_DEFAULT_WIDTH)
      writeWidth(undefined)
    },
  }
}

/**
 * The divider between the list and the inspector: drag it, use the arrow keys, or double-click it
 * to go back to the default width. It measures the row it sits in, so the clamp follows the panel.
 */
export function TraceSplitter({
  width,
  onChange,
  onReset,
}: {
  width: number
  onChange(width: number): void
  onReset(): void
}) {
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const available = () => ref.current?.parentElement?.getBoundingClientRect().width || window.innerWidth
  const right = () => ref.current?.parentElement?.getBoundingClientRect().right ?? window.innerWidth
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    onChange(clampInspectorWidth(right() - event.clientX, available()))
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a resizable divider; <hr> cannot take focus or keys.
    <div
      ref={ref}
      className="trace-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={traceText('trace.splitter')}
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      tabIndex={0}
      data-dragging={dragging || undefined}
      data-testid="trace-splitter"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        setDragging(false)
      }}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={onReset}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
        event.preventDefault()
        if (event.key === 'Home') onReset()
        else
          onChange(
            clampInspectorWidth(width + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP), available()),
          )
      }}
    />
  )
}
