import { type DecisionHandle, type ProfileServiceReceipt, validateMethod } from '@agnes/protocol'

/** Browser-local presentation requests. Authority and decision state remain on the server. */
export function createProfileAttention() {
  let value: { count: number; mode?: 'inbox' | 'decision'; decision?: DecisionHandle; anchor?: HTMLElement } =
    { count: 0 }
  let live = true
  let current: (() => boolean) | undefined
  let observer: MutationObserver | undefined
  const listeners = new Set<() => void>()
  const publish = (next: typeof value) => {
    value = next
    for (const listener of listeners) listener()
  }
  const close = () => {
    current = undefined
    observer?.disconnect()
    observer = undefined
    publish({ count: value.count })
  }
  const reconcile = () => {
    if (current && !current()) close()
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => value,
    setCount(count: number) {
      if (value.count !== count) publish({ ...value, count })
    },
    openInbox() {
      close()
      publish({ count: value.count, mode: 'inbox' })
    },
    receive(result: unknown, isCurrent: () => boolean, anchor?: HTMLElement) {
      if (!live || !isCurrent() || !validateMethod('_agnes/v1/extension.callScoped', 'result', result).ok)
        return
      const receipt = result as ProfileServiceReceipt
      if (receipt.state !== 'approval-required' || !receipt.decision) return
      close()
      current = isCurrent
      publish({
        count: value.count,
        mode: 'decision',
        decision: receipt.decision,
        ...(anchor ? { anchor } : {}),
      })
      observer = new MutationObserver(reconcile)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'open'],
      })
    },
    reconcile,
    close,
    dispose() {
      live = false
      close()
      listeners.clear()
    },
  }
}
export type ProfileAttention = ReturnType<typeof createProfileAttention>
