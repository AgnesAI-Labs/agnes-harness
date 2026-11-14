// Adapted from dsh-superagent (MIT)
/** SQLite persistence for domain aggregates, key-value state, settings history, and the channel outbox. */

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import {
  type ChannelRef,
  type Decision,
  key,
  type OutboundMessage,
  type ReplyStatus,
  type Repositories,
  type Thread,
  type ThreadFact,
  type ThreadFacts,
  type Ticket,
  type Trigger,
  type TriggerDisposition,
  threadKey,
} from '../core/index.js'
import { type Family, type Key, KV } from '../kv.js'
import { type Settings, type SettingsOrigin, type SettingsSave, SettingsSchema } from '../policy.js'
import { migrate, OLDEST_SCHEMA, SCHEMA_VERSION, tooOld } from './migrations/index.js'
import { storeReads } from './store-read.js'
import { Versions } from './versions.js'

/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
export interface TimelinePlace {
  at: string
  id: string
}
/** Why a message was dropped: its conversation can never receive it (`channelGone`), or its Source no longer listens to it (`channelIgnored`). */
export type DropReason = 'channelGone' | 'channelIgnored'
/** Outbound message receipt tracked in the outbox from the moment it is queued (`pending`, `sent`, or `dropped`); delivery attempt counts live on its `reply` effect. */
export interface Receipt extends OutboundMessage {
  status: ReplyStatus
  dropped?: { at: string; reason: DropReason }
}
/** A dropped outbound message receipt, with the timestamp and reason it was dropped. */
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }
/** Saved settings snapshot with the policy version and ticket notifications it produced (`internal` saves have no origin). */
export interface SettingsVersion {
  revision: number
  savedAt: string
  source: SettingsOrigin | 'internal'
  block?: SettingsSave
  policyVersion: string
  policyChanged: boolean
  notified: string[]
  settings: Settings
}
/**
 * Generated columns and partial indexes defining active working sets so passes scan only active rows.
 * They are part of the tables' CREATE statements; a database whose schema differs is refused by version, not altered.
 */
const SETS: Record<string, Record<string, string>> = {
  ticket: {
    open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
    // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
    active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
  },
  thread: {
    active:
      "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
    subscribed:
      "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
  },
  // Composite key (ticketId + thread) used to preserve per-conversation reply order.
  outbox: {
    dropped: "TEXT AS (value ->> '$.dropped.at')",
    pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)`,
  },
}

/** The generated-column definitions of `table`, as the tail of its column list. */
const generated = (table: string): string =>
  Object.entries(SETS[table] ?? {})
    .map(([name, definition]) => `, ${name} ${definition}`)
    .join('')
/** The partial index of each generated working-set column. */
const workingSetIndexes = (): string =>
  Object.entries(SETS)
    .flatMap(([table, definitions]) =>
      Object.keys(definitions).map(
        (name) =>
          `CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL;`,
      ),
    )
    .join('\n')

export { SCHEMA_VERSION }
/**
 * SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
 * The Runtime opens it after locking the state directory and opens only databases of a supported schema version.
 * The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
 */
export class Store implements Repositories {
  readonly db: DatabaseSync
  /**
   * Opens or creates the SQLite database at `path`, migrating an older schema in a single transaction.
   * @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
   * @throws When the database schema is older than `OLDEST_SCHEMA`, newer than `SCHEMA_VERSION`, or when migration fails; in every case the database file is left unchanged and the SQLite handle is closed so a later attempt in the same process can open it.
   */
  constructor(
    path: string,
    private readonly report: (error: unknown) => void = () => {},
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.read = storeReads(this.db)
    try {
      chmodSync(path, 0o600)
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      )
      const version = this.get(KV.store.schema)
      if (version !== undefined && version > SCHEMA_VERSION)
        throw new Error(`Unsupported orchestrator database version ${version}`)
      if (version !== undefined && version < OLDEST_SCHEMA) throw new Error(tooOld(version))
      const migrating = version !== undefined && version < SCHEMA_VERSION
      try {
        this.atomic(() => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL${generated('thread')});
            CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL${generated('ticket')});
            CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL${generated('outbox')});
            CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
              PRIMARY KEY (thread, id));
            CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
              generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
              since TEXT NOT NULL, PRIMARY KEY (kind, key));
            CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
            CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
            CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
            CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
            ${workingSetIndexes()}
          `)
          if (migrating) migrate(this, version)
          if (version !== SCHEMA_VERSION) this.set(KV.store.schema, SCHEMA_VERSION)
        })
      } catch (error) {
        if (!migrating) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(
          `The orchestrator database is unchanged at schema ${version}: its migration to schema ${SCHEMA_VERSION} failed: ${reason}`,
          { cause: error },
        )
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  /** Closes the underlying SQLite database connection. */
  close(): void {
    this.db.close()
  }
  /** Parses JSON `value` columns returned by `sql`. */
  private values<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.db
      .prepare(sql)
      .all(...parameters)
      .map((row) => JSON.parse(String(row.value)) as T)
  }
  /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
  private indexThreads(trigger: Trigger): void {
    this.db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id)
    const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)')
    for (const ref of trigger.threads)
      insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0)
  }
  private depth = 0
  /** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
  private readonly committed: (() => void)[][] = []
  /**
   * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
   * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `orchestrator_atomic_${level}`
    this.committed[level] = []
    this.db.exec(`SAVEPOINT ${name}`)
    let value: T
    try {
      value = operation()
      this.db.exec(`RELEASE ${name}`)
    } catch (error) {
      this.db.exec(`ROLLBACK TO ${name}`)
      this.db.exec(`RELEASE ${name}`)
      throw error
    } finally {
      this.depth--
    }
    const actions = this.committed.splice(level)[0]!
    if (level) this.committed[level - 1]!.push(...actions)
    else
      for (const action of actions) {
        try {
          action()
        } catch (error) {
          this.report(error)
        }
      }
    return value
  }
  /**
   * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
   * callbacks queued inside a transaction that rolls back are discarded and never run.
   * Use `afterCommit` for immediate in-memory follow-ups to a committed write (such as refreshing health or cancelling an in-memory turn) that cannot wait for the effect queue and need not survive a restart; use `Effects` for durable side effects that must survive a crash.
   */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }
  /** Reads a typed KV record by its key in `KV`. */
  get<V>(name: Key<V>): V | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(name)
    return row === undefined ? undefined : (JSON.parse(String(row.value)) as V)
  }
  /** Writes a typed KV record under `name`. */
  set<V>(name: Key<V>, value: V): void {
    this.db
      .prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(name, JSON.stringify(value))
  }
  /** Deletes the KV record at `name`. */
  delete(name: string): void {
    this.db.prepare('DELETE FROM kv WHERE key=?').run(name)
  }
  /** Returns all KV keys belonging to `family` or starting with `prefix`. */
  keys<V>(family: Family<V, never>): Key<V>[]
  keys(prefix: string): string[]
  keys(family: string | { prefix: string }): string[] {
    const prefix = typeof family === 'string' ? family : family.prefix
    const pattern = `${prefix.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
    return this.db
      .prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'")
      .all(pattern)
      .map((row) => String(row.key))
  }

  /** Versioned settings snapshots; the current settings are the snapshot of the latest revision. */
  private readonly settingsVersions = new Versions<SettingsVersion>(
    this,
    KV.settings.revision,
    KV.settings.version,
  )
  /** Current validated settings. */
  settings(): Settings {
    return SettingsSchema.parse(this.settingsVersions.current()?.settings ?? {})
  }
  /** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
  blockRevision(block: SettingsSave): number {
    return this.get(KV.settings.block(block)) ?? 0
  }
  /** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
  saveSettings(
    value: unknown,
    record: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'> = {
      source: 'internal',
      policyVersion: '',
      policyChanged: false,
      notified: [],
    },
  ): Settings {
    const settings = SettingsSchema.parse(value)
    return this.atomic(() => {
      this.settingsVersions.save((revision) => ({
        ...record,
        revision,
        savedAt: new Date().toISOString(),
        settings,
      }))
      if (record.block) this.set(KV.settings.block(record.block), this.blockRevision(record.block) + 1)
      return settings
    })
  }
  /** Saved settings revisions, newest first; revisions predating settings history are absent. */
  settingsHistory(limit = 20): SettingsVersion[] {
    return this.settingsVersions.list(limit)
  }

  readonly triggers = {
    get: (id: string): Trigger | undefined => {
      const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id)
      return row ? (JSON.parse(String(row.value)) as Trigger) : undefined
    },
    save: (trigger: Trigger): void =>
      this.atomic(() => {
        this.db
          .prepare(
            'INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at',
          )
          .run(trigger.id, JSON.stringify(trigger), trigger.at)
        this.indexThreads(trigger)
      }),
    disposition: (id: string): TriggerDisposition | undefined => {
      const row = this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id)
      return row ? (JSON.parse(String(row.value)) as TriggerDisposition) : undefined
    },
    saveDisposition: (id: string, value: TriggerDisposition): void => {
      this.db
        .prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
        .run(id, JSON.stringify(value))
    },
  }
  readonly threads = {
    get: (keyValue: string): Thread | undefined => {
      const row = this.db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue)
      return row ? (JSON.parse(String(row.value)) as Thread) : undefined
    },
    save: (thread: Thread): void => {
      this.db
        .prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(thread.key, JSON.stringify(thread))
    },
    list: (): Thread[] =>
      this.db
        .prepare('SELECT value FROM thread ORDER BY rowid')
        .all()
        .map((row) => JSON.parse(String(row.value)) as Thread),
    active: (): Thread[] => this.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
    /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
    describe: (
      keyValue: string,
      patch: { label?: string; url?: string; facts?: Record<string, ThreadFact | null> },
    ): void => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const facts: ThreadFacts = { ...(thread.meta.facts as ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) {
        if (fact) facts[id] = fact
        else delete facts[id]
      }
      const meta = {
        ...thread.meta,
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.url === undefined ? {} : { url: patch.url }),
        facts,
      }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    },
    /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void =>
      this.atomic(() => {
        const thread = this.threads.get(keyValue)
        if (!thread) return
        const meta = { ...thread.meta }
        for (const [name, value] of Object.entries(patch)) {
          if (value === undefined) delete meta[name]
          else meta[name] = value
        }
        if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
      }),
  }
  readonly tickets = {
    get: (id: string): Ticket | undefined => {
      const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id)
      return row ? (JSON.parse(String(row.value)) as Ticket) : undefined
    },
    save: (ticket: Ticket): void => {
      this.db
        .prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
        .run(ticket.id, JSON.stringify(ticket))
    },
    /** Newest first. */
    list: (): Ticket[] => this.values('SELECT value FROM ticket ORDER BY rowid DESC'),
    /** Newest first. */
    open: (): Ticket[] => this.values('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
    /** Newest first. */
    active: (): Ticket[] => this.values('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
  }
  readonly decisions = {
    get: (id: string): Decision | undefined => {
      const row = this.db.prepare('SELECT value FROM decision WHERE id=?').get(id)
      return row ? (JSON.parse(String(row.value)) as Decision) : undefined
    },
    save: (decision: Decision): void => {
      this.db
        .prepare(
          'INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread',
        )
        .run(decision.id, decision.threadKey, JSON.stringify(decision))
    },
    byThread: (threadKeyValue: string): Decision[] =>
      this.db
        .prepare('SELECT value FROM decision WHERE thread=? ORDER BY rowid')
        .all(threadKeyValue)
        .map((row) => JSON.parse(String(row.value)) as Decision),
  }
  /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
  readonly read: ReturnType<typeof storeReads>

  /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
  replyStatus(id: string): ReplyStatus | undefined {
    return this.receipts.get(id)?.status
  }
  /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
  readonly receipts = {
    get: (id: string): Receipt | undefined =>
      this.values<Receipt>('SELECT value FROM outbox WHERE id = ?', id)[0],
    /** Pending message receipts, oldest first. */
    waiting: (): Receipt[] =>
      this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
    /** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` consecutive failed `reply` effect attempts. */
    behind: (id: string, failures: number): boolean =>
      !!this.db
        .prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`)
        .get(id, failures),
    /**
     * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
     * @returns Whether the message ID was newly recorded.
     */
    add: (message: OutboundMessage): boolean => {
      const receipt: Receipt = { ...message, status: 'pending' }
      return (
        Number(
          this.db
            .prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
            .run(message.id, JSON.stringify(receipt)).changes,
        ) > 0
      )
    },
    /**
     * Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
     * was withdrawn while being sent so its ID cannot be queued again.
     */
    settle: (message: OutboundMessage, outcome: 'sent' | DropReason): void => {
      const settled =
        outcome === 'sent'
          ? { status: 'sent' }
          : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      const { id, channel, text, kind, ticketId } = message
      const updated = this.db
        .prepare(
          "UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'",
        )
        .run(JSON.stringify(settled), id)
      if (!Number(updated.changes))
        this.db
          .prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
          .run(id, JSON.stringify({ id, channel, text, kind, ...(ticketId ? { ticketId } : {}), ...settled }))
    },
    /**
     * Withdraws a pending message that has not yet been sent.
     * @returns Whether a pending message with `id` was waiting and removed.
     */
    withdraw: (id: string): boolean =>
      Number(
        this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id)
          .changes,
      ) > 0,
  }
}
export type { ChannelRef }
export { key, threadKey }

/** Opens or creates the database at `path`, migrating older supported schemas; the caller closes it. */
export function openStore(path: string, report?: (error: unknown) => void): Store {
  return new Store(path, report)
}
