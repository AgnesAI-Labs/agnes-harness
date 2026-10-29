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
      if (result.outcome !== 'success' || seen.has(result.id)) return
      seen.add(result.id)
      store.set(enqueueFeedback(store.getSnapshot(), result))
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
