import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

/**
 * Which tabs of a strip do not fit. The current tab always stays; the others fill what is left in
 * order, and one too wide for the remaining room is skipped so a narrower later one can still show.
 */
export function overflowingTabs(
  widths: readonly number[],
  gap: number,
  available: number,
  activeIndex: number,
): number[] {
  const all = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1)
  // An unmeasured strip (not laid out yet) hides nothing.
  if (available <= 0 || all <= available) return []
  const active = activeIndex >= 0 ? (widths[activeIndex] ?? 0) : 0
  let used = active
  const shown = new Set(activeIndex >= 0 ? [activeIndex] : [])
  for (let index = 0; index < widths.length; index += 1) {
    if (index === activeIndex) continue
    const next = used + (shown.size > 0 ? gap : 0) + (widths[index] ?? 0)
    // A wide tab folds on its own; a narrower later one may still fit.
    if (next > available) continue
    used = next
    shown.add(index)
  }
  return widths.map((_, index) => index).filter((index) => !shown.has(index))
}

/**
 * Measures a tab strip and reports the ids of the tabs that do not fit, so the owner can fold them
 * into a menu. Every tab stays in the strip (a folded one is out of flow and invisible), so each
 * keeps a measurable width and the result follows the strip as it is resized.
 */
export function useTabOverflow(
  ids: readonly string[],
  activeId: string | undefined,
  signature: string,
): { strip: RefObject<HTMLDivElement>; hidden: readonly string[] } {
  const strip = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState<readonly string[]>([])
  const latest = useRef({ ids, activeId })
  latest.current = { ids, activeId }
  // biome-ignore lint/correctness/useExhaustiveDependencies: labels and the current tab change tab widths
  useLayoutEffect(() => {
    const element = strip.current
    if (!element) return
    const measure = () => {
      const tabs = [...element.children] as HTMLElement[]
      const style = getComputedStyle(element)
      const available =
        element.clientWidth -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0)
      const next = overflowingTabs(
        tabs.map((tab) => tab.getBoundingClientRect().width),
        Number.parseFloat(style.columnGap) || 0,
        available,
        latest.current.activeId ? latest.current.ids.indexOf(latest.current.activeId) : -1,
      ).map((index) => latest.current.ids[index] ?? '')
      setHidden((previous) =>
        previous.length === next.length && previous.every((id, index) => id === next[index])
          ? previous
          : next,
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [signature, activeId])
  return { strip, hidden }
}
