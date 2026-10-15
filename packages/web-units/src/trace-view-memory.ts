/** Which view (conversation or trace) each session was last left in, kept for this tab only. */
export const TRACE_VIEWS_STORAGE_KEY = 'agnes.web.traceViews'
const LIMIT = 50

type Store = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The trace is a per-session choice. A new session, or any session with nothing recorded yet,
 * always opens on the conversation so there is a composer to start from; a session with records
 * returns to the view it was left in. Before any session has been chosen in this tab, the last
 * global choice (from before a reload) stands in for the first session shown.
 */
export function createTraceViewMemory(store: Store, legacy: boolean | undefined) {
  let views: Array<[string, boolean]> = []
  try {
    const parsed: unknown = JSON.parse(store.getItem(TRACE_VIEWS_STORAGE_KEY) ?? '[]')
    if (Array.isArray(parsed))
      views = parsed.filter(
        (entry): entry is [string, boolean] =>
          Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean',
      )
  } catch {}
  let fallback = legacy
  const keyOf = (sessionId: string | undefined) => sessionId ?? ''
  return {
    /** Whether the trace should show for this session, given whether it has any records. */
    viewFor(sessionId: string | undefined, hasRecords: boolean): boolean {
      // The pre-reload choice only answers the very first decision in this tab.
      const first = fallback ?? false
      fallback = undefined
      if (!hasRecords) return false
      const remembered = views.find(([key]) => key === keyOf(sessionId))
      return remembered ? remembered[1] : first
    },
    /** The person chose a view for this session. */
    remember(sessionId: string | undefined, trace: boolean): void {
      fallback = undefined
      const key = keyOf(sessionId)
      views = [...views.filter(([item]) => item !== key), [key, trace] as [string, boolean]].slice(-LIMIT)
      try {
        store.setItem(TRACE_VIEWS_STORAGE_KEY, JSON.stringify(views))
      } catch {}
    },
  }
}
