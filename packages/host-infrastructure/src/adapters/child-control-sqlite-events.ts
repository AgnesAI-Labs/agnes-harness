import type { DatabaseSync } from 'node:sqlite'
import {
  type AppendChildEventInput,
  type AppendChildEventResult,
  type ChildEventEnvelope,
  type ChildEventReplayResult,
  type ChildExecutionState,
  type ChildLeaseRecord,
  isTerminalChildState,
} from '@agnes/core'

type Db = Pick<DatabaseSync, 'prepare' | 'exec'>

export type ReservationRecord = {
  permitId: string
  rootTaskId: string
  scopeIds: string[]
  qMicro: bigint
  effectId: string
  requestHash: string
  writerGeneration: number
  status: 'held' | 'settled' | 'released' | 'unknown'
}

type OriginEnvelope = {
  v: 2
  permitId: string
  effectId: string
  requestHash: string
  writerGeneration: number
  scopeIds: string[]
}

export function originEnvelope(reservation: ReservationRecord): OriginEnvelope {
  return {
    v: 2,
    permitId: reservation.permitId,
    effectId: reservation.effectId,
    requestHash: reservation.requestHash,
    writerGeneration: reservation.writerGeneration,
    scopeIds: [...reservation.scopeIds],
  }
}

export function sameOriginEnvelope(value: unknown, expected: OriginEnvelope): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).sort()
  if (keys.join(',') !== 'effectId,permitId,requestHash,scopeIds,v,writerGeneration') return false
  return (
    row.v === 2 &&
    row.permitId === expected.permitId &&
    row.effectId === expected.effectId &&
    row.requestHash === expected.requestHash &&
    row.writerGeneration === expected.writerGeneration &&
    Array.isArray(row.scopeIds) &&
    row.scopeIds.length === expected.scopeIds.length &&
    row.scopeIds.every((scope, index) => scope === expected.scopeIds[index])
  )
}

const MAX_CHILD_EVENTS = 1000
const ONE_CREDIT_MICRO = 1_000_000n

const CHILD_EVENTS_DDL = [
  `CREATE TABLE IF NOT EXISTS child_events (
     child_key TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, ts INTEGER NOT NULL,
     kind TEXT NOT NULL, state TEXT, status TEXT, lease_until INTEGER, payload TEXT,
     PRIMARY KEY (child_key, seq))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS child_events_event_id ON child_events (child_key, event_id)`,
  `CREATE TABLE IF NOT EXISTS child_event_meta (
     child_key TEXT PRIMARY KEY, high_water_seq INTEGER NOT NULL DEFAULT 0,
     dropped_out_of_order INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS child_leases (
     child_key TEXT PRIMARY KEY, parent_key TEXT, owner_run_id TEXT NOT NULL,
     last_heartbeat_at INTEGER NOT NULL, lease_until INTEGER NOT NULL,
     heartbeat_seq INTEGER NOT NULL, missed_count INTEGER NOT NULL, disconnected_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS child_leases_parent ON child_leases (parent_key)`,
]

function parseEnvelope(row: Record<string, unknown>): ChildEventEnvelope {
  return Object.freeze({
    eventId: String(row.event_id),
    childKey: String(row.child_key),
    seq: Number(row.seq),
    ts: Number(row.ts),
    kind: row.kind as ChildEventEnvelope['kind'],
    ...(row.state !== null && row.state !== undefined ? { state: row.state as ChildExecutionState } : {}),
    ...(row.status !== null && row.status !== undefined
      ? { status: row.status as NonNullable<ChildEventEnvelope['status']> }
      : {}),
    ...(row.lease_until !== null && row.lease_until !== undefined
      ? { leaseUntil: Number(row.lease_until) }
      : {}),
    ...(row.payload !== null && row.payload !== undefined
      ? { payload: JSON.parse(String(row.payload)) as NonNullable<ChildEventEnvelope['payload']> }
      : {}),
  })
}

function parseLease(row: Record<string, unknown>): ChildLeaseRecord {
  return Object.freeze({
    childKey: String(row.child_key),
    ...(row.parent_key !== null && row.parent_key !== undefined ? { parentKey: String(row.parent_key) } : {}),
    ownerRunId: String(row.owner_run_id),
    lastHeartbeatAt: Number(row.last_heartbeat_at),
    leaseUntil: Number(row.lease_until),
    heartbeatSeq: Number(row.heartbeat_seq),
    missedCount: Number(row.missed_count),
    ...(row.disconnected_at !== null && row.disconnected_at !== undefined
      ? { disconnectedAt: Number(row.disconnected_at) }
      : {}),
  })
}

/**
 * Computes unconsumed cap reserved by active/non-terminal direct child scopes under `ancestorScopeId`.
 * Runs inside the same SQLite transaction as `createDelegatedChild`, preventing concurrent over-allocation.
 */
export function sqliteUnconsumedChildCapMicro(
  db: Db,
  ancestorScopeId: string,
  ancestorCapMicro: bigint,
  maxFanOut: number,
): bigint {
  const rows = db
    .prepare(
      `SELECT bs.cap_micro, bs.settled_micro, bs.held_micro
       FROM budget_scopes bs
       INNER JOIN child_tasks ct ON ct.child_key = bs.child_key
       WHERE bs.parent_scope_id = ?
         AND bs.child_key IS NOT NULL
         AND ct.creation_phase != 'cancelled'
         AND ct.state NOT IN ('completed', 'failed', 'cancelled')`,
    )
    .all(ancestorScopeId) as Array<{ cap_micro: string; settled_micro: string; held_micro: string }>
  let reserved = 0n
  for (const row of rows) {
    const remaining = BigInt(row.cap_micro) - BigInt(row.settled_micro) - BigInt(row.held_micro)
    if (remaining > 0n) reserved += remaining
  }
  const fanDiv = BigInt(Math.max(1, maxFanOut))
  const perUnboundedFloor =
    ancestorCapMicro / fanDiv < ONE_CREDIT_MICRO ? ancestorCapMicro / fanDiv : ONE_CREDIT_MICRO
  if (perUnboundedFloor > 0n) {
    const unbounded = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM child_tasks ct
         WHERE ct.budget_scope_id = ?
           AND ct.creation_phase != 'cancelled'
           AND ct.state NOT IN ('completed', 'failed', 'cancelled')
           AND NOT EXISTS (SELECT 1 FROM budget_scopes bs WHERE bs.child_key = ct.child_key)`,
      )
      .get(ancestorScopeId) as { n: number } | undefined
    const count = BigInt(Number(unbounded?.n ?? 0))
    if (count > 0n) reserved += count * perUnboundedFloor
  }
  return reserved
}

/** Durable SQLite port for child event streams and heartbeat leases (lazily initialized). */
export function sqliteChildEventPort(db: Db, tx: <T>(fn: () => T) => T) {
  let initialized = false
  const ensureTables = () => {
    if (initialized) return
    for (const ddl of CHILD_EVENTS_DDL) db.exec(ddl)
    initialized = true
  }

  return {
    async appendChildEvent(event: AppendChildEventInput): Promise<AppendChildEventResult> {
      return tx(() => {
        ensureTables()
        const existing = db
          .prepare('SELECT * FROM child_events WHERE child_key = ? AND event_id = ?')
          .get(event.childKey, event.eventId) as Record<string, unknown> | undefined
        if (existing) {
          return { accepted: false, duplicate: true, envelope: parseEnvelope(existing) }
        }
        const meta = db
          .prepare('SELECT high_water_seq, dropped_out_of_order FROM child_event_meta WHERE child_key = ?')
          .get(event.childKey) as { high_water_seq: number; dropped_out_of_order: number } | undefined
        const highWaterSeq = meta?.high_water_seq ?? 0
        if (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq <= highWaterSeq)) {
          db.prepare(
            `INSERT INTO child_event_meta (child_key, high_water_seq, dropped_out_of_order) VALUES (?, ?, 1)
             ON CONFLICT(child_key) DO UPDATE SET dropped_out_of_order = dropped_out_of_order + 1`,
          ).run(event.childKey, highWaterSeq)
          return {
            accepted: false,
            outOfOrder: true,
            envelope: Object.freeze({ ...event, seq: event.seq ?? highWaterSeq }),
          }
        }
        const taskRow = db.prepare('SELECT state FROM child_tasks WHERE child_key = ?').get(event.childKey) as
          | { state: string }
          | undefined
        if (
          taskRow &&
          isTerminalChildState(taskRow.state as ChildExecutionState) &&
          event.kind === 'status' &&
          event.state !== undefined &&
          !isTerminalChildState(event.state)
        ) {
          return {
            accepted: false,
            terminalLocked: true,
            envelope: Object.freeze({ ...event, seq: event.seq ?? highWaterSeq }),
          }
        }
        const seq = event.seq ?? highWaterSeq + 1
        db.prepare(
          `INSERT INTO child_events (child_key, seq, event_id, ts, kind, state, status, lease_until, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.childKey,
          seq,
          event.eventId,
          event.ts,
          event.kind,
          event.state ?? null,
          event.status ?? null,
          event.leaseUntil ?? null,
          event.payload ? JSON.stringify(event.payload) : null,
        )
        db.prepare(
          `INSERT INTO child_event_meta (child_key, high_water_seq, dropped_out_of_order) VALUES (?, ?, 0)
           ON CONFLICT(child_key) DO UPDATE SET high_water_seq = excluded.high_water_seq`,
        ).run(event.childKey, seq)
        db.prepare(
          `DELETE FROM child_events
           WHERE child_key = ?
             AND (state IS NULL OR state NOT IN ('completed', 'failed', 'cancelled'))
             AND seq NOT IN (
               SELECT seq FROM child_events WHERE child_key = ? ORDER BY seq DESC LIMIT ?
             )`,
        ).run(event.childKey, event.childKey, MAX_CHILD_EVENTS)
        return { accepted: true, envelope: Object.freeze({ ...event, seq }) }
      })
    },

    async scanChildEvents(
      childKey: string,
      opts?: { afterSeq?: number; limit?: number },
    ): Promise<ChildEventReplayResult> {
      ensureTables()
      const after = opts?.afterSeq ?? 0
      const limit = opts?.limit && opts.limit > 0 ? opts.limit : 10_000
      const rows = db
        .prepare('SELECT * FROM child_events WHERE child_key = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
        .all(childKey, after, limit) as Array<Record<string, unknown>>
      const meta = db
        .prepare('SELECT high_water_seq, dropped_out_of_order FROM child_event_meta WHERE child_key = ?')
        .get(childKey) as { high_water_seq: number; dropped_out_of_order: number } | undefined
      return {
        events: rows.map(parseEnvelope),
        highWaterSeq: meta?.high_water_seq ?? 0,
        droppedOutOfOrder: meta?.dropped_out_of_order ?? 0,
      }
    },

    async upsertChildLease(lease: ChildLeaseRecord): Promise<void> {
      tx(() => {
        ensureTables()
        let parentKey = lease.parentKey ?? null
        if (!parentKey) {
          const task = db
            .prepare('SELECT parent_key FROM child_tasks WHERE child_key = ?')
            .get(lease.childKey) as { parent_key: string } | undefined
          parentKey = task?.parent_key ?? null
        }
        db.prepare(
          `INSERT INTO child_leases
             (child_key, parent_key, owner_run_id, last_heartbeat_at, lease_until, heartbeat_seq, missed_count, disconnected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(child_key) DO UPDATE SET
             parent_key = COALESCE(excluded.parent_key, child_leases.parent_key),
             owner_run_id = excluded.owner_run_id,
             last_heartbeat_at = excluded.last_heartbeat_at,
             lease_until = excluded.lease_until,
             heartbeat_seq = excluded.heartbeat_seq,
             missed_count = excluded.missed_count,
             disconnected_at = excluded.disconnected_at`,
        ).run(
          lease.childKey,
          parentKey,
          lease.ownerRunId,
          lease.lastHeartbeatAt,
          lease.leaseUntil,
          lease.heartbeatSeq,
          lease.missedCount,
          lease.disconnectedAt ?? null,
        )
      })
    },

    async lookupChildLease(childKey: string): Promise<ChildLeaseRecord | null> {
      ensureTables()
      const row = db.prepare('SELECT * FROM child_leases WHERE child_key = ?').get(childKey) as
        | Record<string, unknown>
        | undefined
      return row ? parseLease(row) : null
    },

    async listChildLeasesByParent(parentKey: string): Promise<ChildLeaseRecord[]> {
      ensureTables()
      const rows = db
        .prepare('SELECT * FROM child_leases WHERE parent_key = ? ORDER BY child_key ASC')
        .all(parentKey) as Array<Record<string, unknown>>
      return rows.map(parseLease)
    },
  }
}
