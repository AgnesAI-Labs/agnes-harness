import type { JobSpec, Schedule } from '@agnes/protocol'
import { ensure, type TableHandle } from '../storage/table.js'

export type JobStatusName = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'dead' | 'cancelled'
export type JobPayload = JobSpec['payload']
export type JobSchedule = Schedule

export type JobRow = {
  idempotencyKey: string
  sessionKey: string
  profileHash: string
  payload: JobPayload
  schedule: JobSchedule
  status: JobStatusName
  attempts: number
  maxAttempts: number
  backoffMs: number
  delayUntil: number
  leaseOwner?: string
  leaseUntil?: number
  heartbeat?: number
  stalledCounter: number
  budget?: number
  protected: boolean
  result?: unknown
  error?: string
  createdAt: number
  updatedAt: number
}

type RawJobRow = {
  idempotency_key: string
  session_key: string
  profile_hash: string
  payload: string
  schedule: string
  status: JobStatusName
  attempts: number
  max_attempts: number
  backoff_ms: number
  delay_until: number
  lease_owner: string | null
  lease_until: number | null
  heartbeat: number | null
  stalled_counter: number
  budget: number | null
  protected: number
  result: string | null
  error: string | null
  created_at: number
  updated_at: number
}

const DDL = `CREATE TABLE IF NOT EXISTS jobs (
  idempotency_key TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  schedule TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  backoff_ms INTEGER NOT NULL DEFAULT 1000,
  delay_until INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  heartbeat INTEGER,
  stalled_counter INTEGER NOT NULL DEFAULT 0,
  budget REAL,
  protected INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`

const TERMINAL = new Set<JobStatusName>(['completed', 'failed', 'dead', 'cancelled'])

function toRow(raw: RawJobRow): JobRow {
  return {
    idempotencyKey: raw.idempotency_key,
    sessionKey: raw.session_key,
    profileHash: raw.profile_hash,
    payload: JSON.parse(raw.payload) as JobPayload,
    schedule: JSON.parse(raw.schedule) as JobSchedule,
    status: raw.status,
    attempts: raw.attempts,
    maxAttempts: raw.max_attempts,
    backoffMs: raw.backoff_ms,
    delayUntil: raw.delay_until,
    ...(raw.lease_owner !== null ? { leaseOwner: raw.lease_owner } : {}),
    ...(raw.lease_until !== null ? { leaseUntil: raw.lease_until } : {}),
    ...(raw.heartbeat !== null ? { heartbeat: raw.heartbeat } : {}),
    stalledCounter: raw.stalled_counter,
    ...(raw.budget !== null ? { budget: raw.budget } : {}),
    protected: raw.protected === 1,
    ...(raw.result !== null ? { result: JSON.parse(raw.result) as unknown } : {}),
    ...(raw.error !== null ? { error: raw.error } : {}),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }
}

export class JobsRepo {
  constructor(
    private readonly table: TableHandle,
    private readonly clock: () => number,
  ) {
    ensure(table, DDL)
    ensure(table, 'CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, delay_until)')
    ensure(table, 'CREATE INDEX IF NOT EXISTS jobs_session ON jobs (session_key, status)')
  }

  insert(job: JobRow): boolean {
    return this.table.transaction(() => {
      if (this.get(job.idempotencyKey)) return false
      this.table.exec(
        `INSERT INTO jobs (
          idempotency_key, session_key, profile_hash, payload, schedule, status,
          attempts, max_attempts, backoff_ms, delay_until, lease_owner, lease_until,
          heartbeat, stalled_counter, budget, protected, result, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.idempotencyKey,
          job.sessionKey,
          job.profileHash,
          JSON.stringify(job.payload),
          JSON.stringify(job.schedule),
          job.status,
          job.attempts,
          job.maxAttempts,
          job.backoffMs,
          job.delayUntil,
          job.leaseOwner ?? null,
          job.leaseUntil ?? null,
          job.heartbeat ?? null,
          job.stalledCounter,
          job.budget ?? null,
          job.protected ? 1 : 0,
          job.result === undefined ? null : JSON.stringify(job.result),
          job.error ?? null,
          job.createdAt,
          job.updatedAt,
        ],
      )
      return true
    })
  }

  get(key: string): JobRow | undefined {
    const raw = this.table.get<RawJobRow>('SELECT * FROM jobs WHERE idempotency_key = ?', [key])
    return raw ? toRow(raw) : undefined
  }

  claimDue(now: number, owner: string, lockMs: number, max: number): JobRow[] {
    if (max <= 0) return []
    const due = this.table.all<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM jobs
       WHERE status = 'waiting' AND delay_until <= ?
       ORDER BY created_at, idempotency_key LIMIT ?`,
      [now, max],
    )
    const claimed: JobRow[] = []
    for (const candidate of due) {
      const job = this.table.transaction(() => {
        const before = this.get(candidate.idempotency_key)
        if (before?.status !== 'waiting' || before.delayUntil > now) return undefined
        this.table.exec(
          `UPDATE jobs SET status = 'active', lease_owner = ?, lease_until = ?, heartbeat = ?, updated_at = ?
           WHERE idempotency_key = ? AND status = 'waiting' AND delay_until <= ?`,
          [owner, now + lockMs, now, now, candidate.idempotency_key, now],
        )
        const current = this.get(candidate.idempotency_key)
        return current?.status === 'active' && current.leaseOwner === owner && current.heartbeat === now
          ? current
          : undefined
      })
      if (job) claimed.push(job)
    }
    return claimed
  }

  heartbeat(key: string, owner: string, now: number): void {
    this.table.exec(
      `UPDATE jobs
       SET lease_until = ? + MAX(0, lease_until - heartbeat), heartbeat = ?, updated_at = ?
       WHERE idempotency_key = ? AND lease_owner = ? AND status = 'active'`,
      [now, now, now, key, owner],
    )
  }

  settle(
    key: string,
    update: {
      status: 'completed' | 'failed' | 'dead' | 'waiting' | 'delayed'
      result?: unknown
      error?: string
      delayUntil?: number
      attempts?: number
    },
  ): void {
    this.table.exec(
      `UPDATE jobs SET status = ?, result = COALESCE(?, result), error = ?,
       delay_until = COALESCE(?, delay_until), attempts = COALESCE(?, attempts),
       lease_owner = NULL, lease_until = NULL, heartbeat = NULL, updated_at = ?
       WHERE idempotency_key = ? AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')`,
      [
        update.status,
        update.result === undefined ? null : JSON.stringify(update.result),
        update.error ?? null,
        update.delayUntil ?? null,
        update.attempts ?? null,
        this.clock(),
        key,
      ],
    )
  }

  promoteDelayed(now: number): number {
    const due = this.table.all<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM jobs WHERE status = 'delayed' AND delay_until <= ?",
      [now],
    )
    if (due.length === 0) return 0
    this.table.exec(
      "UPDATE jobs SET status = 'waiting', updated_at = ? WHERE status = 'delayed' AND delay_until <= ?",
      [now, now],
    )
    return due.length
  }

  reclaimStalled(now: number, maxStalled: number): { requeued: string[]; dead: string[] } {
    const rows = this.table.all<{ idempotency_key: string; stalled_counter: number }>(
      "SELECT idempotency_key, stalled_counter FROM jobs WHERE status = 'active' AND lease_until < ? ORDER BY idempotency_key",
      [now],
    )
    const requeued: string[] = []
    const dead: string[] = []
    for (const row of rows) {
      const stalledCounter = row.stalled_counter + 1
      if (stalledCounter > maxStalled) {
        this.table.exec(
          `UPDATE jobs SET status = 'dead', stalled_counter = ?, error = 'stalled',
           lease_owner = NULL, lease_until = NULL, heartbeat = NULL, updated_at = ?
           WHERE idempotency_key = ? AND status = 'active' AND lease_until < ?`,
          [stalledCounter, now, row.idempotency_key, now],
        )
        if (this.get(row.idempotency_key)?.status === 'dead') dead.push(row.idempotency_key)
      } else {
        this.table.exec(
          `UPDATE jobs SET status = 'waiting', stalled_counter = ?, error = NULL,
           lease_owner = NULL, lease_until = NULL, heartbeat = NULL, updated_at = ?
           WHERE idempotency_key = ? AND status = 'active' AND lease_until < ?`,
          [stalledCounter, now, row.idempotency_key, now],
        )
        if (this.get(row.idempotency_key)?.status === 'waiting') requeued.push(row.idempotency_key)
      }
    }
    return { requeued, dead }
  }

  cancel(key: string): 'cancelled' | 'not-found' | 'terminal' {
    const job = this.get(key)
    if (!job) return 'not-found'
    if (TERMINAL.has(job.status)) return 'terminal'
    this.table.exec(
      `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_until = NULL,
       heartbeat = NULL, updated_at = ? WHERE idempotency_key = ? AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')`,
      [this.clock(), key],
    )
    return this.get(key)?.status === 'cancelled' ? 'cancelled' : 'terminal'
  }

  countWaiting(sessionKey: string): number {
    return (
      this.table.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM jobs WHERE session_key = ? AND status IN ('waiting', 'delayed')",
        [sessionKey],
      )?.count ?? 0
    )
  }

  waitingDepth(over: number): Array<{ sessionKey: string; depth: number }> {
    return this.table
      .all<{ session_key: string; depth: number }>(
        `SELECT session_key, COUNT(*) AS depth FROM jobs
         WHERE status IN ('waiting', 'delayed') GROUP BY session_key HAVING COUNT(*) > ?
         ORDER BY session_key`,
        [over],
      )
      .map((row) => ({ sessionKey: row.session_key, depth: row.depth }))
  }

  oldestActive(now: number): number | undefined {
    const row = this.table.get<{ updated_at: number | null }>(
      "SELECT MIN(updated_at) AS updated_at FROM jobs WHERE status = 'active'",
    )
    return row?.updated_at === null || row?.updated_at === undefined ? undefined : now - row.updated_at
  }

  activeSince(): Array<{ key: string; since: number }> {
    return this.table
      .all<{ idempotency_key: string; updated_at: number }>(
        "SELECT idempotency_key, updated_at FROM jobs WHERE status = 'active' ORDER BY idempotency_key",
      )
      .map((row) => ({ key: row.idempotency_key, since: row.updated_at }))
  }
}
