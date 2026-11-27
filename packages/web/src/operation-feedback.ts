import {
  createExternalStore,
  emptyFeedback,
  enqueueFeedback,
  type FeedbackSink,
  type FeedbackSnapshot,
} from '@agnes/web-ui'

/** Shell lifetime: routes can unmount without dropping outcomes or unresolved consequences. */
export function createOperationFeedback() {
  const store = createExternalStore<FeedbackSnapshot>(emptyFeedback)
  const seen = new Set<string>()
  const sink: FeedbackSink = {
    publish(result) {
      if (seen.has(result.id)) return
      const current = store.getSnapshot()
      const next = enqueueFeedback(current, result)
      if (next === current) return
      seen.add(result.id)
      store.set(next)
    },
    resolve(scope) {
      const snapshot = store.getSnapshot()
      store.set({ ...snapshot, notices: snapshot.notices.filter((item) => item.scope !== scope) })
    },
  }
  return {
    store,
    sink,
    dismiss(id: string) {
      const snapshot = store.getSnapshot()
      store.set({ ...snapshot, queue: snapshot.queue.filter((item) => item.id !== id) })
    },
  }
}
