import type { PageSessionMeta, SessionPreferences } from '@agnes/protocol'

type Row = PageSessionMeta['items'][number]

/** The same empty list every time, so an unchanged session reads as unchanged. */
const NONE: readonly string[] = Object.freeze([])

const unavailable = (error: unknown) => {
  const failure = error as { code?: unknown; data?: { code?: unknown } } | undefined
  return failure?.code === -32601 || failure?.data?.code === 'METHOD_NOT_FOUND'
}

/**
 * The bookmarked prompts of the open session, kept with the session in the daemon. Bookmarks are
 * user message ids. A daemon without the method gets no bookmark control.
 */
export function createSessionBookmarks(options: {
  rows: () => Row[]
  save?: ((sessionId: string, bookmarks: readonly string[]) => Promise<SessionPreferences>) | undefined
  /** Repaint the transcript after a saved list arrives. */
  changed: () => void
}) {
  let supported = options.save !== undefined
  // A session that is not in the loaded session list keeps its saved list here.
  const unlisted = new Map<string, readonly string[]>()
  return {
    read(
      sessionId: string,
    ):
      | { bookmarks: readonly string[]; setBookmarks: (next: readonly string[]) => Promise<void> }
      | undefined {
      const save = options.save
      if (!supported || !save) return undefined
      const row = options.rows().find((item) => item.sessionId === sessionId)
      return {
        bookmarks: row ? (row.bookmarks ?? NONE) : (unlisted.get(sessionId) ?? NONE),
        setBookmarks: async (next) => {
          try {
            const saved = (await save(sessionId, next)).bookmarks ?? NONE
            const rows = options.rows()
            const index = rows.findIndex((item) => item.sessionId === sessionId)
            const listed = rows[index]
            if (listed) rows[index] = { ...listed, bookmarks: [...saved] }
            else unlisted.set(sessionId, saved)
          } catch (error) {
            if (unavailable(error)) supported = false
            throw error
          } finally {
            options.changed()
          }
        },
      }
    },
  }
}
