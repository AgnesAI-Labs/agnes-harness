export type StoredHistoryView = { id: string; timeline: unknown; hasEarlier: boolean; reason?: string }

export type StoredHistoryDeps = {
  storedOpening(id: string): Promise<{ timeline: unknown; hasEarlier: boolean }>
  show(view: StoredHistoryView): void
  clear(): void
  delayMs?: number
}

/**
 * While a full open is slow or after it fails, shows the stored history read-only. The live session
 * replaces it as soon as session/load finishes; a failed load keeps it and says why.
 *
 * One open at a time: `started` forgets whatever an earlier open left pending, and a stored history
 * that arrives after its open has finished is dropped rather than shown over the live session. A
 * history already on screen stays until the next open settles, then is replaced or cleared.
 */
export function createStoredHistory(deps: StoredHistoryDeps) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let shown = false
  let generation = 0
  let read: { id: string; view: Promise<{ timeline: unknown; hasEarlier: boolean }> } | undefined
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const reveal = async (id: string, reason?: string): Promise<boolean> => {
    const mine = generation
    // Read once per open: a failure after the delayed read shows the same history with its reason.
    if (read?.id !== id) read = { id, view: Promise.resolve().then(() => deps.storedOpening(id)) }
    let view: { timeline: unknown; hasEarlier: boolean }
    try {
      view = await read.view
    } catch {
      // The recovery notice still reports the original failure.
      if (mine === generation) read = undefined
      return false
    }
    if (mine !== generation) return false
    shown = true
    deps.show({ id, timeline: view.timeline, hasEarlier: view.hasEarlier, ...(reason ? { reason } : {}) })
    return true
  }
  return {
    started(id: string): void {
      stop()
      generation++
      // A history shown for an earlier open stays until this open settles, like the old transcript.
      read = undefined
      timer = setTimeout(() => {
        timer = undefined
        void reveal(id)
      }, deps.delayMs ?? 10_000)
    },
    succeeded(): void {
      stop()
      generation++
      read = undefined
      if (shown) deps.clear()
      shown = false
    },
    /** Shows the stored history with the reason the open failed; false when there is none to show. */
    async failed(id: string, reason: string): Promise<boolean> {
      stop()
      const ok = await reveal(id, reason)
      generation++
      read = undefined
      if (!ok && shown) {
        shown = false
        deps.clear()
      }
      return ok
    },
  }
}
