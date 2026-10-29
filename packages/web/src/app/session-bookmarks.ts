import type { PageSessionMeta, SessionPreferences } from '@agnes/protocol'

type Row = PageSessionMeta['items'][number]

/** The same empty list every time, so an unchanged session reads as unchanged. */
const NONE: readonly string[] = Object.freeze([])

const unavailable = (error: unknown) => {
  const failure = error as { code?: unknown; data?: { code?: unknown } } | undefined
  return failure?.code === -32601 || failure?.data?.code === 'METHOD_NOT_FOUND'
}

/** One session's saves: the newest list the reader asked for and how far the daemon has caught up. */
type SessionSaves = {
  /** Shown until the save that carries it settles; an older response never replaces it. */
  intent?: readonly string[]
  /** Bumped by every change the reader makes. */
  version: number
  /** The newest version a successful save covered, and the newest a failed save covered. */
  saved: number
  failed?: { version: number; error: unknown }
  /** Saves run one after another, each sending the newest intent. */
  queue: Promise<void>
}

/**
 * The bookmarked prompts of the open session, kept with the session in the daemon. Bookmarks are
 * user message ids. A daemon without the method gets no bookmark control.
 *
 * The daemon replaces the whole list on every save, so saves for one session never overlap: each
 * waits for the one before and sends the newest list, which also covers any change queued behind
 * it. A response for an older list updates the saved row but leaves the newer intent on screen, and
 * a failure puts the saved list back only when no newer change is waiting.
 */
export function createSessionBookmarks(options: {
  rows: () => Row[]
  save?: ((sessionId: string, bookmarks: readonly string[]) => Promise<SessionPreferences>) | undefined
  /** Repaint the transcript after the shown list changes. */
  changed: () => void
}) {
  let supported = options.save !== undefined
  // A session that is not in the loaded session list keeps its saved list here.
  const unlisted = new Map<string, readonly string[]>()
  const sessions = new Map<string, SessionSaves>()
  const savesOf = (sessionId: string) => {
    let saves = sessions.get(sessionId)
    if (!saves) {
      saves = { version: 0, saved: 0, queue: Promise.resolve() }
      sessions.set(sessionId, saves)
    }
    return saves
  }
  const store = (sessionId: string, saved: readonly string[]) => {
    const rows = options.rows()
    const index = rows.findIndex((item) => item.sessionId === sessionId)
    const listed = rows[index]
    if (listed) rows[index] = { ...listed, bookmarks: [...saved] }
    else unlisted.set(sessionId, saved)
  }
  return {
    read(
      sessionId: string,
    ):
      | { bookmarks: readonly string[]; setBookmarks: (next: readonly string[]) => Promise<void> }
      | undefined {
      const save = options.save
      if (!supported || !save) return undefined
      const row = options.rows().find((item) => item.sessionId === sessionId)
      const saves = sessions.get(sessionId)
      return {
        bookmarks: saves?.intent ?? (row ? (row.bookmarks ?? NONE) : (unlisted.get(sessionId) ?? NONE)),
        setBookmarks: (next) => {
          const saves = savesOf(sessionId)
          const version = ++saves.version
          saves.intent = next
          options.changed()
          const run = saves.queue.then(async () => {
            // A save that started after this change already sent it (or a newer list).
            if (saves.saved >= version) return
            if (saves.failed && saves.failed.version >= version) throw saves.failed.error
            const sending = saves.intent ?? next
            const covers = saves.version
            try {
              store(sessionId, (await save(sessionId, sending)).bookmarks ?? NONE)
              saves.saved = covers
              if (saves.version === covers) delete saves.intent
            } catch (error) {
              if (unavailable(error)) supported = false
              saves.failed = { version: covers, error }
              if (saves.version === covers) delete saves.intent
              throw error
            } finally {
              options.changed()
            }
          })
          saves.queue = run.catch(() => undefined)
          return run
        },
      }
    },
  }
}
