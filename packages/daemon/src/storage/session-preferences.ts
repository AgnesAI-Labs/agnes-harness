import { rpcError, type SessionPreferences } from '@agnes/protocol'
import type { SessionLister, SessionMetaRow } from '../local/ports.js'
import type { TableHandle } from './table.js'

/** Presentation preferences are independent of generated titles and conversation history. */
export class SessionPreferencesStore {
  private readonly memory = new Map<string, SessionPreferences>()

  constructor(private readonly table?: TableHandle) {
    table?.exec(`CREATE TABLE IF NOT EXISTS session_preferences (
      session_key TEXT PRIMARY KEY, title TEXT, archived INTEGER NOT NULL DEFAULT 0
    )`)
  }

  get(sessionId: string): SessionPreferences {
    if (!this.table) return { archived: false, ...this.memory.get(sessionId) }
    const row = this.table.get<{ title: string | null; archived: number }>(
      'SELECT title, archived FROM session_preferences WHERE session_key = ?',
      [sessionId],
    )
    return { archived: row?.archived === 1, ...(row?.title ? { title: row.title } : {}) }
  }

  rename(sessionId: string, title: string): SessionPreferences {
    const normalized = title.trim()
    if (
      !normalized ||
      Array.from(normalized).length > 80 ||
      /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(normalized)
    )
      throw rpcError('SEMANTIC_REJECTED', { reason: '标题需为 1–80 个字符的单行可见文本。' })
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

  apply(row: SessionMetaRow): SessionMetaRow {
    const preference = this.get(row.sessionId)
    return {
      ...row,
      archived: preference.archived,
      ...(preference.title ? { title: preference.title, titleSource: 'user' as const } : {}),
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
