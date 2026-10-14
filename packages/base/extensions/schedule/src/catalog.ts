import { randomUUID } from 'node:crypto'
import type { JobSchedule } from '../../../src/schedule-cron.js'

import {
  compile,
  compileTarget,
  delayFor,
  MAX_PROMPT,
  type NewSessionTarget,
  reject,
  type ScheduleCode,
  ScheduleRejected,
  type ScheduleRun,
  type ScheduleRunOutcome,
  type ScheduleSelector,
  type ScheduleStatus,
  type ScheduleTarget,
  type ScheduleView,
  type ScheduleWrite,
  textField,
} from './rules.js'

export {
  compileTarget,
  type NewSessionTarget,
  type ScheduleCode,
  ScheduleRejected,
  type ScheduleRun,
  type ScheduleRunOutcome,
  type ScheduleSelector,
  type ScheduleStatus,
  type ScheduleTarget,
  type ScheduleView,
  type ScheduleWrite,
} from './rules.js'

export type ScheduleDb = {
  exec(sql: string, params?: readonly unknown[]): void
  get<T>(sql: string, params?: readonly unknown[]): T | undefined
  all<T>(sql: string, params?: readonly unknown[]): T[]
  transaction<T>(fn: () => T): T
}

type DaemonTable = {
  exec(sql: string, params?: unknown[]): void
  get<T>(sql: string, params?: unknown[]): T | undefined
  all<T>(sql: string, params?: unknown[]): T[]
  transaction<T>(fn: () => T): T
}
type SeamTable = {
  exec(sql: string): void
  run(sql: string, params?: readonly unknown[]): { changes: number }
  get<T>(sql: string, params?: readonly unknown[]): T | undefined
  all<T>(sql: string, params?: readonly unknown[]): T[]
  transaction<T>(fn: () => T): T
}

const SCHEDULE_KEY = /^schedule:(sched_[a-f0-9]{16}):(\d+)$/

// Locked copy of JobsRepo's DDL. The worker may insert a reminder before the daemon opens jobs.
const JOBS_DDL = `CREATE TABLE IF NOT EXISTS jobs (
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

function bind(params?: readonly unknown[]): unknown[] | undefined {
  return params ? [...params] : undefined
}

export function openDaemonScheduleDb(table: DaemonTable): ScheduleDb {
  return {
    exec(sql, params) {
      table.exec(sql, bind(params))
    },
    get(sql, params) {
      return table.get(sql, bind(params))
    },
    all(sql, params) {
      return table.all(sql, bind(params))
    },
    transaction(fn) {
      return table.transaction(fn)
    },
  }
}

export function openSeamScheduleDb(table: SeamTable): ScheduleDb {
  return {
    exec(sql, params) {
      if (params && params.length > 0) table.run(sql, params)
      else table.exec(sql)
    },
    get(sql, params) {
      return table.get(sql, params)
    },
    all(sql, params) {
      return table.all(sql, params)
    },
    transaction(fn) {
      return table.transaction(fn)
    },
  }
}

function ensureScheduleSchema(db: ScheduleDb): void {
  db.exec(JOBS_DDL)
  db.exec('CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, delay_until)')
  db.exec('CREATE INDEX IF NOT EXISTS jobs_session ON jobs (session_key, status)')
  db.exec(`CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    selector TEXT NOT NULL,
    status TEXT NOT NULL,
    job_key TEXT,
    revision INTEGER NOT NULL,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS schedules_session ON schedules (session_key, status)')
  // Rows written before targets existed have no target row and read as their session.
  db.exec(`CREATE TABLE IF NOT EXISTS schedule_targets (
    schedule_id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    origin TEXT
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS schedule_runs (
    schedule_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    session_key TEXT,
    ended_at INTEGER,
    seq INTEGER,
    reason TEXT,
    detail TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs (schedule_id, at)')
  db.exec('CREATE INDEX IF NOT EXISTS schedule_runs_session ON schedule_runs (session_key, at)')
}

type ScheduleRow = {
  id: string
  session_key: string
  title: string
  prompt: string
  selector: string
  status: ScheduleStatus
  job_key: string | null
  revision: number
  next_run_at: number | null
  created_at: number
  updated_at: number
}

function scheduleId(): string {
  return `sched_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function jobKey(id: string, revision: number): string {
  return `schedule:${id}:${revision}`
}

type Compiled = {
  target: ScheduleTarget
  origin: string | undefined
  /** `schedules.session_key`: the bound session, or the session that created a new-session task. */
  owner: string
  title: string
  prompt: string
  stored: ScheduleSelector
  schedule: JobSchedule
}

function compileWrite(input: ScheduleWrite, mode: 'create' | 'update', now: number): Compiled {
  const given = typeof input.origin === 'string' && input.origin.length > 0 ? input.origin : undefined
  const target = compileTarget(input.target, given)
  // A task bound to a session belongs to it even when nothing named a creator.
  const origin = given ?? (target.kind === 'session' ? target.sessionKey : undefined)
  return {
    target,
    origin,
    owner: target.kind === 'session' ? target.sessionKey : (origin ?? ''),
    title: textField(input.title, 120),
    prompt: textField(input.prompt, MAX_PROMPT),
    ...compile(input.selector, mode, now),
  }
}

/** The job's session: the bound one, or a placeholder the daemon replaces with a fresh session per run. */
function jobSession(id: string, target: ScheduleTarget): string {
  return target.kind === 'session' ? target.sessionKey : `schedule:${id}`
}

function insertJob(
  db: ScheduleDb,
  key: string,
  sessionKey: string,
  prompt: string,
  schedule: JobSchedule,
  delay: number,
  now: number,
): void {
  db.exec(
    `INSERT INTO jobs (
      idempotency_key, session_key, profile_hash, payload, schedule, status,
      attempts, max_attempts, backoff_ms, delay_until, lease_owner, lease_until,
      heartbeat, stalled_counter, budget, protected, result, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      key,
      sessionKey,
      'schedule',
      JSON.stringify({ prompt }),
      JSON.stringify(schedule),
      'waiting',
      0,
      3,
      1000,
      delay,
      null,
      null,
      null,
      0,
      null,
      0,
      null,
      null,
      now,
      now,
    ],
  )
}

function cancelQueued(db: ScheduleDb, key: string | null, now: number): void {
  if (!key) return
  db.exec(
    `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, heartbeat = NULL, updated_at = ?
     WHERE idempotency_key = ? AND status IN ('waiting', 'delayed')`,
    [now, key],
  )
}

function jobStatus(db: ScheduleDb, key: string | null): string | undefined {
  if (!key) return undefined
  return db.get<{ status: string }>('SELECT status FROM jobs WHERE idempotency_key = ?', [key])?.status
}

function writeTarget(db: ScheduleDb, id: string, target: ScheduleTarget, origin: string | undefined): void {
  db.exec('DELETE FROM schedule_targets WHERE schedule_id = ?', [id])
  db.exec('INSERT INTO schedule_targets (schedule_id, target, origin) VALUES (?, ?, ?)', [
    id,
    JSON.stringify(target),
    origin ?? null,
  ])
}

const clipDetail = (value: string | undefined) => (value ? value.slice(0, 500) : undefined)

export type ScheduleCatalog = {
  create(input: ScheduleWrite): ScheduleView
  update(input: ScheduleWrite & { id: string }): ScheduleView | { updated: false; code: ScheduleCode }
  archive(id: string): { deleted: boolean }
  /** Run now, pause, or resume. A refusal names a code and changes nothing. */
  control(
    id: string,
    action: 'run' | 'pause' | 'resume',
  ): ScheduleView | { updated: false; code: ScheduleCode }
  list(query: { sessionKey?: string; includeArchived?: boolean; limit?: number }): ScheduleView[]
  read(id: string): ScheduleView | undefined
  /** The task behind a job key, for the daemon to resolve a new-session target before running. */
  targetOf(jobKey: string): { id: string; title: string; target: ScheduleTarget } | undefined
  recordDispatch(
    jobKey: string,
    info: { at: number; seq?: number; reason?: string; sessionKey?: string },
  ): void
  noteSettlement(jobKey: string, info: { nextRunAt: number | null; at?: number }): void
  recordFailure(
    jobKey: string,
    info: { at: number; reason: string; detail?: string; sessionKey?: string },
  ): void
  stillWaiting(jobKey: string): boolean
  recentDelivery(sessionKey: string, since: number): { title: string; prompt: string } | undefined
}

type RunRow = {
  at: number
  outcome: ScheduleRunOutcome
  session_key: string | null
  ended_at: number | null
  seq: number | null
  reason: string | null
  detail: string | null
}

export function openScheduleCatalog(db: ScheduleDb, clock: () => number = () => Date.now()): ScheduleCatalog {
  ensureScheduleSchema(db)
  const load = (id: string): ScheduleRow | undefined =>
    db.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', [id])
  const targetRow = (id: string) =>
    db.get<{ target: string; origin: string | null }>(
      'SELECT target, origin FROM schedule_targets WHERE schedule_id = ?',
      [id],
    )
  const targetFor = (row: ScheduleRow): { target: ScheduleTarget; origin?: string } => {
    const stored = targetRow(row.id)
    if (stored) {
      try {
        return {
          target: compileTarget(JSON.parse(stored.target)),
          ...(stored.origin ? { origin: stored.origin } : {}),
        }
      } catch {
        // An unreadable target falls back to the session the row names, like a row from before targets.
      }
    }
    return { target: { kind: 'session', sessionKey: row.session_key }, origin: row.session_key }
  }
  const runs = (id: string): ScheduleRun[] =>
    db
      .all<RunRow>(
        `SELECT at, outcome, session_key, ended_at, seq, reason, detail FROM (
           SELECT *, rowid AS rid FROM schedule_runs
           WHERE schedule_id = ? ORDER BY at DESC, rowid DESC LIMIT 20
         ) ORDER BY at ASC, rid ASC`,
        [id],
      )
      .map((row) => ({
        at: row.at,
        outcome: row.outcome,
        ...(row.session_key === null ? {} : { sessionKey: row.session_key }),
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        ...(row.seq === null ? {} : { seq: row.seq }),
        ...(row.reason === null ? {} : { reason: row.reason }),
        ...(row.detail === null ? {} : { detail: row.detail }),
      }))
  const viewOf = (row: ScheduleRow): ScheduleView => {
    const { target, origin } = targetFor(row)
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      selector: JSON.parse(row.selector) as ScheduleSelector,
      target,
      ...(origin ? { origin } : {}),
      status: row.status,
      nextRunAt: row.next_run_at,
      revision: row.revision,
      runs: runs(row.id),
    }
  }
  const read = (id: string): ScheduleView | undefined => {
    const row = load(id)
    return row ? viewOf(row) : undefined
  }
  const idOf = (key: string) => SCHEDULE_KEY.exec(key)?.[1]
  /** The run a job started and has not closed: the one its settlement or failure finishes. */
  const openRun = (key: string) =>
    db.get<{ rid: number }>(
      `SELECT rowid AS rid FROM schedule_runs WHERE job_key = ? AND outcome = 'running'
       ORDER BY at DESC, rowid DESC LIMIT 1`,
      [key],
    )
  const insertRun = (id: string, key: string, run: ScheduleRun) =>
    db.transaction(() => {
      db.exec(
        `INSERT INTO schedule_runs (schedule_id, job_key, at, outcome, session_key, ended_at, seq, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          key,
          run.at,
          run.outcome,
          run.sessionKey ?? null,
          run.endedAt ?? null,
          run.seq ?? null,
          run.reason ?? null,
          run.detail ?? null,
        ],
      )
      db.exec(
        `DELETE FROM schedule_runs WHERE schedule_id = ? AND rowid NOT IN (
           SELECT rowid FROM schedule_runs WHERE schedule_id = ? ORDER BY at DESC, rowid DESC LIMIT 50
         )`,
        [id, id],
      )
    })
  /** A new job for the stored rule, counted from now; used by resume. */
  const restart = (row: ScheduleRow, now: number) => {
    const { target } = targetFor(row)
    const stored = JSON.parse(row.selector) as ScheduleSelector
    const { schedule } = compile(stored, 'create', now)
    const next = delayFor(schedule, now)
    const revision = row.revision + 1
    const key = jobKey(row.id, revision)
    insertJob(db, key, jobSession(row.id, target), row.prompt, schedule, next, now)
    return { key, revision, next }
  }
  return {
    create(input) {
      const now = clock()
      const compiled = compileWrite(input, 'create', now)
      const id = scheduleId()
      const key = jobKey(id, 1)
      const delay = delayFor(compiled.schedule, now)
      db.transaction(() => {
        insertJob(db, key, jobSession(id, compiled.target), compiled.prompt, compiled.schedule, delay, now)
        db.exec(
          `INSERT INTO schedules (
             id, session_key, title, prompt, selector, status, job_key, revision, next_run_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, ?)`,
          [
            id,
            compiled.owner,
            compiled.title,
            compiled.prompt,
            JSON.stringify(compiled.stored),
            key,
            delay,
            now,
            now,
          ],
        )
        writeTarget(db, id, compiled.target, compiled.origin)
      })
      const created = read(id)
      if (!created) reject('internal_error')
      return created
    },
    update(input) {
      const now = clock()
      const row = load(input.id)
      if (!row || (input.owner !== undefined && row.session_key !== input.owner))
        return { updated: false, code: 'schedule_not_found' }
      if (row.status !== 'active' && row.status !== 'paused')
        return { updated: false, code: 'schedule_ended' }
      const before = targetFor(row)
      const compiled = compileWrite(
        { ...input, target: input.target ?? before.target, origin: before.origin ?? input.origin },
        'update',
        now,
      )
      const stored = JSON.stringify(compiled.stored)
      const promptChanged = compiled.prompt !== row.prompt
      const selectorChanged = stored !== row.selector
      const targetChanged = JSON.stringify(compiled.target) !== JSON.stringify(before.target)
      const status = jobStatus(db, row.job_key)
      if (status === 'active' && (promptChanged || selectorChanged || targetChanged))
        return { updated: false, code: 'schedule_conflict' }
      const paused = row.status === 'paused'
      db.transaction(() => {
        let key = row.job_key
        let revision = row.revision
        let next = row.next_run_at
        if (status === 'active') {
          db.exec('UPDATE schedules SET title = ?, updated_at = ? WHERE id = ?', [
            compiled.title,
            now,
            row.id,
          ])
          return
        }
        if (paused) {
          // A paused task has no queued job; the new rule takes effect when it is resumed.
        } else if (
          selectorChanged ||
          targetChanged ||
          (promptChanged && status !== 'waiting' && status !== 'delayed')
        ) {
          cancelQueued(db, key, now)
          revision += 1
          key = jobKey(row.id, revision)
          next = delayFor(compiled.schedule, now)
          insertJob(
            db,
            key,
            jobSession(row.id, compiled.target),
            compiled.prompt,
            compiled.schedule,
            next,
            now,
          )
        } else if (promptChanged && key) {
          db.exec(
            `UPDATE jobs SET payload = ?, updated_at = ? WHERE idempotency_key = ? AND status IN ('waiting', 'delayed')`,
            [JSON.stringify({ prompt: compiled.prompt }), now, key],
          )
        }
        db.exec(
          `UPDATE schedules
           SET session_key = ?, title = ?, prompt = ?, selector = ?, job_key = ?, revision = ?, next_run_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('active', 'paused')`,
          [compiled.owner, compiled.title, compiled.prompt, stored, key, revision, next, now, row.id],
        )
        writeTarget(db, row.id, compiled.target, compiled.origin)
      })
      const updated = read(input.id)
      if (updated?.status !== 'active' && updated?.status !== 'paused')
        return { updated: false, code: 'schedule_ended' }
      return updated
    },
    archive(id) {
      const row = load(id)
      if (row?.status !== 'active' && row?.status !== 'paused') return { deleted: false }
      const now = clock()
      const status = jobStatus(db, row.job_key)
      db.transaction(() => {
        if (status === 'waiting' || status === 'delayed') cancelQueued(db, row.job_key, now)
        db.exec(
          `UPDATE schedules SET status = 'archived', updated_at = ? WHERE id = ? AND status IN ('active', 'paused')`,
          [now, id],
        )
      })
      return { deleted: true }
    },
    control(id, action) {
      const row = load(id)
      if (!row) return { updated: false, code: 'schedule_not_found' }
      const now = clock()
      const status = jobStatus(db, row.job_key)
      if (action === 'pause') {
        if (row.status === 'paused') return viewOf(row)
        if (row.status !== 'active') return { updated: false, code: 'schedule_ended' }
        db.transaction(() => {
          // A run already in progress finishes; it just does not schedule another.
          cancelQueued(db, row.job_key, now)
          db.exec(
            `UPDATE schedules SET status = 'paused', next_run_at = NULL, updated_at = ? WHERE id = ? AND status = 'active'`,
            [now, id],
          )
        })
      } else if (action === 'resume') {
        if (row.status === 'active') return viewOf(row)
        if (row.status !== 'paused') return { updated: false, code: 'schedule_ended' }
        if (status === 'active') return { updated: false, code: 'schedule_running' }
        let restarted: ReturnType<typeof restart>
        try {
          restarted = restart(row, now)
        } catch (error) {
          // A one-time task whose moment has passed cannot resume; it says so instead of running late.
          if (error instanceof ScheduleRejected) return { updated: false, code: error.code }
          throw error
        }
        db.transaction(() => {
          db.exec(
            `UPDATE schedules SET status = 'active', job_key = ?, revision = ?, next_run_at = ?, updated_at = ?
             WHERE id = ? AND status = 'paused'`,
            [restarted.key, restarted.revision, restarted.next, now, id],
          )
        })
      } else {
        if (row.status === 'paused') return { updated: false, code: 'schedule_paused' }
        if (row.status !== 'active') return { updated: false, code: 'schedule_ended' }
        if (status === 'active') return { updated: false, code: 'schedule_running' }
        if (status !== 'waiting' && status !== 'delayed') return { updated: false, code: 'schedule_ended' }
        // The next scheduler tick claims it. A repeating rule continues from this run as usual.
        db.transaction(() => {
          db.exec(
            `UPDATE jobs SET status = 'waiting', delay_until = ?, updated_at = ? WHERE idempotency_key = ? AND status IN ('waiting', 'delayed')`,
            [now, now, row.job_key],
          )
          db.exec('UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
        })
      }
      const value = read(id)
      if (!value) return { updated: false, code: 'internal_error' }
      return value
    },
    list(query) {
      const limit = Math.min(query.limit ?? 500, 500)
      return db
        .all<ScheduleRow>(
          `SELECT * FROM schedules
           WHERE (? IS NULL OR session_key = ?) AND (? = 1 OR status IN ('active', 'paused'))
           ORDER BY COALESCE(next_run_at, 9223372036854775807), id LIMIT ?`,
          [query.sessionKey ?? null, query.sessionKey ?? null, query.includeArchived ? 1 : 0, limit],
        )
        .map(viewOf)
    },
    read,
    targetOf(key) {
      const id = idOf(key)
      const row = id ? load(id) : undefined
      return row ? { id: row.id, title: row.title, target: targetFor(row).target } : undefined
    },
    recordDispatch(key, info) {
      const id = idOf(key)
      if (!id || !load(id)) return
      // `prompt`: an idle session started a turn, which settles later. `resumed`: a resume command.
      // No reason: the prompt joined a turn that was already running.
      const outcome: ScheduleRunOutcome =
        info.reason === 'prompt' ? 'running' : info.reason === 'resumed' ? 'ran' : 'delivered'
      insertRun(id, key, {
        at: info.at,
        outcome,
        ...(info.sessionKey ? { sessionKey: info.sessionKey } : {}),
        ...(info.seq === undefined ? {} : { seq: info.seq }),
      })
    },
    noteSettlement(key, info) {
      const id = idOf(key)
      if (!id) return
      const now = clock()
      const open = openRun(key)
      if (open)
        db.exec(`UPDATE schedule_runs SET outcome = 'ran', ended_at = ? WHERE rowid = ?`, [
          info.at ?? now,
          open.rid,
        ])
      if (info.nextRunAt === null) {
        db.exec(
          `UPDATE schedules SET status = 'ended', next_run_at = NULL, updated_at = ? WHERE id = ? AND status = 'active'`,
          [now, id],
        )
        return
      }
      db.exec(`UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND status = 'active'`, [
        info.nextRunAt,
        now,
        id,
      ])
    },
    recordFailure(key, info) {
      const id = idOf(key)
      if (!id || !load(id)) return
      const reason = info.reason.slice(0, 64)
      const detail = clipDetail(info.detail)
      const open = openRun(key)
      if (open) {
        db.exec(
          `UPDATE schedule_runs SET outcome = 'failed', ended_at = ?, reason = ?, detail = ? WHERE rowid = ?`,
          [info.at, reason, detail ?? null, open.rid],
        )
        return
      }
      insertRun(id, key, {
        at: info.at,
        outcome: 'failed',
        endedAt: info.at,
        reason,
        ...(detail ? { detail } : {}),
        ...(info.sessionKey ? { sessionKey: info.sessionKey } : {}),
      })
    },
    stillWaiting(key) {
      const id = idOf(key)
      if (!id) return true
      return load(id)?.status === 'active'
    },
    recentDelivery(sessionKey, since) {
      return db.get<{ title: string; prompt: string }>(
        `SELECT s.title AS title, s.prompt AS prompt FROM schedule_runs r
         JOIN schedules s ON s.id = r.schedule_id
         WHERE r.session_key = ? AND r.at >= ? AND r.outcome != 'failed' ORDER BY r.at DESC LIMIT 1`,
        [sessionKey, since],
      )
    },
  }
}

/** Checks a new-session target against this computer: the workspace, loop, bundles, preset and model. */
export type ScheduleTargetCheck = (target: NewSessionTarget) => Promise<ScheduleCode | undefined>

export function createSchedulesPort(
  db: ScheduleDb,
  clock: () => number = () => Date.now(),
  check?: ScheduleTargetCheck,
) {
  const catalog = openScheduleCatalog(db, clock)
  const verify = async (target: unknown) => {
    const compiled = compileTarget(target)
    if (compiled.kind === 'new-session' && check) {
      const code = await check(compiled)
      if (code) reject(code)
    }
  }
  return {
    catalog,
    list(params: { scope: 'session' | 'all'; sessionKey?: string; includeArchived?: boolean }) {
      return Promise.resolve({
        schedules: catalog.list({
          ...(params.scope === 'session' ? { sessionKey: params.sessionKey } : {}),
          includeArchived: params.includeArchived === true,
        }),
      })
    },
    async upsert(params: unknown) {
      const body = params as ScheduleWrite
      if (body.id) {
        if (body.target !== undefined) await verify(body.target)
        return catalog.update({ ...body, id: body.id })
      }
      await verify(body.target)
      return catalog.create(body)
    },
    archive(params: { id: string }) {
      return Promise.resolve(catalog.archive(params.id))
    },
    control(params: { id: string; action: 'run' | 'pause' | 'resume' }) {
      return Promise.resolve(catalog.control(params.id, params.action))
    },
    read(id: string) {
      const row = catalog.read(id)
      if (!row) return Promise.resolve(undefined)
      const sessionKey = row.target.kind === 'session' ? row.target.sessionKey : row.origin
      return Promise.resolve({ ...(sessionKey ? { sessionKey } : {}), target: row.target })
    },
    targetOf: catalog.targetOf,
    recordDispatch: catalog.recordDispatch,
    noteSettlement: catalog.noteSettlement,
    recordFailure: catalog.recordFailure,
    stillWaiting: catalog.stillWaiting,
  }
}
