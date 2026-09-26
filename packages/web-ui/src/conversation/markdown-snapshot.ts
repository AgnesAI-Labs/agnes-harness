import { type RefObject, useLayoutEffect, useMemo, useState } from 'react'

type Snapshot = Readonly<{ source: string; streaming: boolean }>

function interactionInside(element: HTMLElement | null): boolean {
  if (!element) return false
  const document = element.ownerDocument
  if (element.contains(document.activeElement)) return true
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed) return false
  if (element.contains(selection.anchorNode) || element.contains(selection.focusNode)) return true
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true
  }
  return false
}

/** Hold the entire React-owned source snapshot while a reader uses its current DOM. */
export function useInteractionSnapshot<T>(host: RefObject<HTMLElement>, next: T): T {
  const [shown, setShown] = useState<T>(() => next)
  useLayoutEffect(() => {
    const element = host.current
    const document = element?.ownerDocument
    const apply = () => setShown(() => next)
    if (!document || !interactionInside(element)) {
      apply()
      return
    }
    let alive = true
    const stop = () => {
      document.removeEventListener('selectionchange', flush)
      document.removeEventListener('pointerup', flush)
      document.removeEventListener('keyup', flush)
      document.removeEventListener('focusout', afterFocusOut)
    }
    const flush = () => {
      if (!alive || interactionInside(host.current)) return
      apply()
      stop()
    }
    const afterFocusOut = () => queueMicrotask(flush)
    document.addEventListener('selectionchange', flush)
    document.addEventListener('pointerup', flush)
    document.addEventListener('keyup', flush)
    document.addEventListener('focusout', afterFocusOut)
    return () => {
      alive = false
      stop()
    }
  }, [host, next])
  return shown
}

export function useMarkdownSnapshot(
  host: RefObject<HTMLElement>,
  source: string,
  streaming: boolean,
): Snapshot {
  const next = useMemo(() => ({ source, streaming }), [source, streaming])
  return useInteractionSnapshot(host, next)
}
