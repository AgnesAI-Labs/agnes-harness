import { rpcError, type SessionPreferences } from '@agnes/protocol'
import type { SessionLister, SessionMetaRow } from '../local/ports.js'
import type { TableHandle } from './table.js'

const BOOKMARK_LIMIT = 200

/** Presentation preferences are independent of generated titles and conversation history. */
export class SessionPreferencesStore {
  private readonly memory = new Map<string, SessionPreferences>()

  constructor(private readonly table?: TableHandle) {
    table?.exec(`CREATE TABLE IF NOT EXISTS session_preferences (
      session_key TEXT PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0
    )`)
    // Its own table rather than a column, so a store created before bookmarks needs no migration.
    table?.exec(`CREATE TABLE IF NOT EXISTS session_bookmarks (
      session_key TEXT PRIMARY KEY, ids TEXT NOT NULL
    )`)
  }

  get(sessionId: string): SessionPreferences {
    if (!this.table) return { archived: false, ...this.memory.get(sessionId) }
    const row = this.table.get<{ title: string | null; archived: number }>(
      'SELECT title, archived FROM session_preferences WHERE session_key = ?',
      [sessionId],
    )
    const bookmarks = this.table.get<{ ids: string }>(
      'SELECT ids FROM session_bookmarks WHERE session_key = ?',
      [sessionId],
    )
    const ids = bookmarks ? (JSON.parse(bookmarks.ids) as string[]) : []
    return {
      archived: row?.archived === 1,
      ...(row?.title ? { title: row.title } : {}),
      ...(ids.length ? { bookmarks: ids } : {}),
    }
  }

  rename(sessionId: string, title: string): SessionPreferences {
    const normalized = title.trim()
    if (
      !normalized ||
      Array.from(normalized).length > 80 ||
      /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(normalized)
    )
      throw rpcError('SEMANTIC_REJECTED', {
        code: 'SESSION_TITLE_INVALID',
        reason: 'A title must be 1–80 characters on one visible line.',
      })
    if (this.table)
      this.table.exec(
        `INSERT INTO session_preferences (session_key, title) VALUES (?, ?)
       ON CONFLICT(session_key) DO UPDATE SET title = excluded.title`,
        [sessionId, normalized],
      )
    else this.memory.set(sessionId, { ...this.get(sessionId), title: normalized })
    return this.get(sessionId)
  }

  archive(sessionId: string, archived: boolean): SessionPreferences {
    if (this.table)
      this.table.exec(
        `INSERT INTO session_preferences (session_key, archived) VALUES (?, ?)
       ON CONFLICT(session_key) DO UPDATE SET archived = excluded.archived`,
        [sessionId, archived ? 1 : 0],
      )
    else this.memory.set(sessionId, { ...this.get(sessionId), archived })
    return this.get(sessionId)
  }

  /**
   * Replaces the bookmarked user prompts. Ids are UINode ids of kind 'user'; a repeat keeps its first
   * place, and an empty list clears the set. Ids are not checked against the transcript: a bookmark
   * whose prompt is no longer shown is simply never matched.
   */
  setBookmarks(sessionId: string, bookmarks: readonly string[]): SessionPreferences {
    const ids = [...new Set(bookmarks)]
    if (
      ids.length > BOOKMARK_LIMIT ||
      ids.some((id) => typeof id !== 'string' || !id || id.length > 128 || /\p{Cc}/u.test(id))
    )
      throw rpcError('SEMANTIC_REJECTED', {
        code: 'SESSION_BOOKMARKS_INVALID',
        reason: 'At most 200 bookmarks, each a turn id of 1–128 visible characters.',
      })
    if (this.table) {
      if (ids.length)
        this.table.exec(
          `INSERT INTO session_bookmarks (session_key, ids) VALUES (?, ?)
         ON CONFLICT(session_key) DO UPDATE SET ids = excluded.ids`,
          [sessionId, JSON.stringify(ids)],
        )
      else this.table.exec('DELETE FROM session_bookmarks WHERE session_key = ?', [sessionId])
    } else {
      const { bookmarks: _previous, ...rest } = this.get(sessionId)
      this.memory.set(sessionId, { ...rest, ...(ids.length ? { bookmarks: ids } : {}) })
    }
    return this.get(sessionId)
  }

  apply(row: SessionMetaRow): SessionMetaRow {
    const preference = this.get(row.sessionId)
    return {
      ...row,
      archived: preference.archived,
      ...(preference.title ? { title: preference.title, titleSource: 'user' as const } : {}),
      ...(preference.bookmarks ? { bookmarks: preference.bookmarks } : {}),
    }
  }
}

export function withSessionPreferences(lister: SessionLister, store: SessionPreferencesStore): SessionLister {
  return {
    async list(query) {
      const page = await lister.list(query)
      return { ...page, items: page.items.map((row) => store.apply(row)) }
    },
  }
}
