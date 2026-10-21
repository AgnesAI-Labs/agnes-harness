import { rpcError, type SessionPreferences } from '@agnes/protocol'
import type { SessionLister, SessionMetaRow } from '../local/ports.js'
import type { TableHandle } from './table.js'

const BOOKMARK_LIMIT = 200

/** Presentation preferences are independent of generated titles and conversation history. */
export class SessionPreferencesStore {
  private readonly memory = new Map<string, SessionPreferences>()

  constructor(
    private readonly table?: TableHandle,
    private readonly clock: () => number = Date.now,
  ) {
    table?.exec(`CREATE TABLE IF NOT EXISTS session_preferences (
      session_key TEXT PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER,
      bookmarks TEXT
    )`)
  }

  get(sessionId: string): SessionPreferences {
    if (!this.table) return { archived: false, ...this.memory.get(sessionId) }
    const row = this.table.get<{
      title: string | null
      archived: number
      pinned_at: number | null
      bookmarks: string | null
    }>('SELECT title, archived, pinned_at, bookmarks FROM session_preferences WHERE session_key = ?', [
      sessionId,
    ])
    const ids = row?.bookmarks ? (JSON.parse(row.bookmarks) as string[]) : []
    return {
      archived: row?.archived === 1,
      ...(row?.title ? { title: row.title } : {}),
      ...(typeof row?.pinned_at === 'number' ? { pinnedAt: new Date(row.pinned_at).toISOString() } : {}),
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

  /** Archiving unpins in the same statement, so an archived session is never in the pinned group. */
  archive(sessionId: string, archived: boolean): SessionPreferences {
    if (this.table)
      this.table.exec(
        `INSERT INTO session_preferences (session_key, archived) VALUES (?, ?)
       ON CONFLICT(session_key) DO UPDATE SET archived = excluded.archived,
         pinned_at = CASE WHEN excluded.archived = 1 THEN NULL ELSE pinned_at END`,
        [sessionId, archived ? 1 : 0],
      )
    else {
      const { pinnedAt, ...rest } = this.get(sessionId)
      this.memory.set(sessionId, { ...rest, archived, ...(pinnedAt && !archived ? { pinnedAt } : {}) })
    }
    return this.get(sessionId)
  }

  /** Pinning a pinned session keeps its time; an archived session must be restored first. */
  pin(sessionId: string, pinned: boolean): SessionPreferences {
    const current = this.get(sessionId)
    if (pinned && current.archived)
      throw rpcError('SEMANTIC_REJECTED', {
        code: 'SESSION_ARCHIVED',
        reason: 'Restore an archived session before pinning it.',
      })
    const at = pinned ? this.clock() : null
    if (this.table)
      this.table.exec(
        `INSERT INTO session_preferences (session_key, pinned_at) VALUES (?, ?)
       ON CONFLICT(session_key) DO UPDATE SET pinned_at = CASE
         WHEN excluded.pinned_at IS NULL THEN NULL ELSE COALESCE(pinned_at, excluded.pinned_at) END`,
        [sessionId, at],
      )
    else {
      const { pinnedAt, ...rest } = current
      this.memory.set(sessionId, {
        ...rest,
        ...(at !== null ? { pinnedAt: pinnedAt ?? new Date(at).toISOString() } : {}),
      })
    }
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
          `INSERT INTO session_preferences (session_key, bookmarks) VALUES (?, ?)
         ON CONFLICT(session_key) DO UPDATE SET bookmarks = excluded.bookmarks`,
          [sessionId, JSON.stringify(ids)],
        )
      else
        this.table.exec('UPDATE session_preferences SET bookmarks = NULL WHERE session_key = ?', [sessionId])
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
      ...(preference.pinnedAt ? { pinnedAt: preference.pinnedAt } : {}),
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
