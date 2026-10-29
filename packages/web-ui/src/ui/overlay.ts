import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

let compositionEndedAt = 0
let compositionListeners = 0
const recordCompositionEnd = () => {
  compositionEndedAt = Date.now()
}

/** Keep antd's 200ms post-IME Escape protection when handling Escape inside a modal. */
export function useEscapeCompositionLock() {
  useEffect(() => {
    if (compositionListeners++ === 0) window.addEventListener('compositionend', recordCompositionEnd)
    return () => {
      if (--compositionListeners === 0) window.removeEventListener('compositionend', recordCompositionEnd)
    }
  }, [])
  return (event: KeyboardEvent) => event.isComposing || Date.now() - compositionEndedAt < 200
}

/** Modal surfaces trap focus through antd; anchored surfaces return to their trigger on dismissal. */
export function useOverlayFocus(open: boolean, restoreOnClose = true) {
  // Capture before antd's child layout effects move focus into an initially open surface.
  const trigger = useMemo(
    () =>
      open &&
      typeof document !== 'undefined' &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      document.activeElement !== document.documentElement
        ? document.activeElement
        : null,
    [open],
  )
  const generation = useRef(0)
  useLayoutEffect(() => {
    if (!open || !restoreOnClose) return
    const current = ++generation.current
    return () => {
      // Child modal traps must release before restoration, including when the region unmounts.
      queueMicrotask(() => {
        if (generation.current === current && trigger?.isConnected) trigger.focus({ preventScroll: true })
      })
    }
  }, [open, restoreOnClose, trigger])
  return () => {
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  }
}

export function useReducedMotion() {
  const [reduce, setReduce] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduce(media.matches)
    media.addEventListener('change', update)
    update()
    return () => media.removeEventListener('change', update)
  }, [])
  return reduce
}
