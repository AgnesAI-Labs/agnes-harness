/**
 * Archives conversations that ended more than two weeks ago so the working tables stay small. A conversation is a thread
 * together with the triggers that reached it and the decisions made on it; it moves to the `*_archive` tables as a whole, or
 * not at all.
 */
import type { SQLInputValue } from 'node:sqlite'
import type { Store } from './store.js'

/** How long a conversation stays after its last activity or the end of its last ticket; the polling horizon of subscribed threads. */
export const ARCHIVE_AFTER_MS = 14 * 24 * 3600_000
/** References longer than this are text, not identifiers. */
const ID_LENGTH = 256

type Row = Record<string, SQLInputValue>
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Collects the identifier-like strings found anywhere in a JSON value. */
function collect(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    if (value && value.length <= ID_LENGTH) into.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, into)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collect(item, into)
  }
}

/** Union-find over the records that must stay together. */
class Groups {
  private readonly parent = new Map<string, string>()
  find(name: string): string {
    let root = name
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root) as string
    this.parent.set(name, root)
    return root
  }
  join(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b))
  }
}

/** Identifiers that active work still refers to: open or delivering tickets, pending messages, and queued effects. */
function referenced(store: Store): { names: Set<string>; activeTickets: Set<string> } {
  const names = new Set<string>()
  const activeTickets = new Set<string>()
  const tickets = store.db.prepare('SELECT id, value FROM ticket WHERE open = 1 OR active = 1').all()
  for (const row of tickets) {
    activeTickets.add(String(row.id))
    collect(JSON.parse(String(row.value)), names)
  }
  for (const receipt of store.receipts.waiting()) {
    collect(receipt, names)
    names.add(`${receipt.channel.source}:${receipt.channel.thread}`)
  }
  for (const row of store.db.prepare('SELECT key, value FROM effect').all()) {
    names.add(String(row.key))
    collect(JSON.parse(String(row.value)), names)
  }
  return { names, activeTickets }
}

/**
 * Moves every conversation that is past the horizon and that nothing active refers to into the archive tables, and returns how
 * many threads, triggers and decisions moved. A conversation stays whole when any part of it is pinned: a trigger, decision or
 * thread newer than the horizon; queued triggers or a running evaluation; a subscribed ticket that is open, delivering, or
 * ended within the horizon; or an identifier used by an active ticket, a pending message or a queued effect. Triggers that
 * belong to several threads tie those threads together.
 */
export function archiveExpired(store: Store, now: number): { archived: number } {
  const cutoff = new Date(now - ARCHIVE_AFTER_MS).toISOString()
  const { db } = store
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_archive (key TEXT PRIMARY KEY, value TEXT NOT NULL, archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trigger_archive (id TEXT PRIMARY KEY, value TEXT NOT NULL, disposition TEXT, archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS decision_archive (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL, archived_at TEXT NOT NULL);
  `)
  const { names, activeTickets } = referenced(store)
  const groups = new Groups()
  const pinned = new Set<string>()
  const pin = (name: string): void => {
    pinned.add(name)
  }
  const old = (at: unknown): boolean => text(at) < cutoff

  const threads = db.prepare('SELECT key, value FROM thread').all()
  const queued = new Set<string>()
  for (const row of threads) {
    const key = `t:${String(row.key)}`
    const thread = JSON.parse(String(row.value)) as {
      key: string
      createdAt: string
      lastAt?: string
      subscriptions: string[]
      pending: string[]
      evaluating?: { triggerIds: string[] }
    }
    groups.find(key)
    for (const id of thread.pending) queued.add(id)
    for (const id of thread.evaluating?.triggerIds ?? []) queued.add(id)
    if (
      thread.pending.length > 0 ||
      thread.evaluating ||
      names.has(thread.key) ||
      !old(thread.lastAt ?? thread.createdAt)
    )
      pin(key)
    for (const id of thread.subscriptions) {
      if (activeTickets.has(id)) pin(key)
      else if (!old(store.tickets.get(id)?.ended?.at)) pin(key)
    }
  }
  for (const row of db.prepare('SELECT id, at FROM trigger').all()) {
    const key = `g:${String(row.id)}`
    groups.find(key)
    if (!old(row.at) || names.has(String(row.id)) || queued.has(String(row.id))) pin(key)
  }
  for (const row of db.prepare('SELECT thread, id FROM trigger_thread').all())
    groups.join(`t:${String(row.thread)}`, `g:${String(row.id)}`)
  const decisions = db
    .prepare("SELECT id, thread, value ->> '$.at' AS at, value -> '$.triggerIds' AS triggers FROM decision")
    .all()
  for (const row of decisions) {
    const key = `d:${String(row.id)}`
    groups.find(key)
    groups.join(key, `t:${String(row.thread)}`)
    for (const id of JSON.parse(String(row.triggers ?? '[]')) as string[]) groups.join(key, `g:${id}`)
    if (!old(row.at) || names.has(String(row.id))) pin(key)
  }
  const keep = new Set([...pinned].map((name) => groups.find(name)))
  const expired = (name: string): boolean => !keep.has(groups.find(name))
  const archivedAt = new Date(now).toISOString()
  return store.atomic(() => {
    let archived = 0
    const moved = (changes: number | bigint): void => {
      archived += Number(changes)
    }
    for (const row of threads.filter((item) => expired(`t:${String(item.key)}`))) {
      db.prepare('INSERT OR REPLACE INTO thread_archive VALUES (?,?,?)').run(
        String(row.key),
        String(row.value),
        archivedAt,
      )
      moved(db.prepare('DELETE FROM thread WHERE key = ?').run(String(row.key)).changes)
    }
    for (const row of db
      .prepare('SELECT id, value FROM trigger')
      .all()
      .filter((item) => expired(`g:${String(item.id)}`))) {
      const id = String(row.id)
      const disposition = db.prepare('SELECT value FROM disposition WHERE id = ?').get(id)?.value
      db.prepare('INSERT OR REPLACE INTO trigger_archive VALUES (?,?,?,?)').run(
        id,
        String(row.value),
        disposition === undefined ? null : String(disposition),
        archivedAt,
      )
      db.prepare('DELETE FROM trigger_thread WHERE id = ?').run(id)
      db.prepare('DELETE FROM disposition WHERE id = ?').run(id)
      moved(db.prepare('DELETE FROM trigger WHERE id = ?').run(id).changes)
    }
    for (const row of db
      .prepare('SELECT id, thread, value FROM decision')
      .all()
      .filter((item: Row) => expired(`d:${String(item.id)}`))) {
      db.prepare('INSERT OR REPLACE INTO decision_archive VALUES (?,?,?,?)').run(
        String(row.id),
        String(row.thread),
        String(row.value),
        archivedAt,
      )
      moved(db.prepare('DELETE FROM decision WHERE id = ?').run(String(row.id)).changes)
    }
    return { archived }
  })
}
