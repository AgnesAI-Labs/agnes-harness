import { randomUUID } from 'node:crypto'
import { type JobSchedule, nextRunAt } from '../../../src/schedule-cron.js'

export type ScheduleCode =
  | 'invalid_prompt'
  | 'invalid_selector'
  | 'invalid_rule'
  | 'invalid_time_zone'
  | 'not_future'
  | 'time_out_of_range'
  | 'frequency_too_high'
  | 'subagent_session'
  | 'internal_error'
  | 'schedule_not_found'
  | 'schedule_ended'
  | 'schedule_conflict'

export class ScheduleRejected extends Error {
  readonly code: ScheduleCode
  constructor(code: ScheduleCode, message: string = code) {
    super(message)
    this.name = 'ScheduleRejected'
    this.code = code
  }
}

export type ScheduleSelector =
  | { after_seconds: number }
  | { at: string }
  | { every_seconds: number }
  | { daily: { time: string; timeZone: string } }
  | { weekly: { time: string; timeZone: string; weekdays: number[] } }
  | { cron: { expr: string; timeZone?: string } }

export type ScheduleDelivery = { at: number; seq?: number; reason?: string }
export type ScheduleStatus = 'active' | 'archived' | 'ended'
export type ScheduleView = {
  id: string
  sessionKey: string
  title: string
  prompt: string
  selector: ScheduleSelector
  status: ScheduleStatus
  nextRunAt: number | null
  revision: number
  deliveries: ScheduleDelivery[]
}
export type ScheduleWrite = {
  sessionKey: string
  title: string
  prompt: string
  selector: unknown
  id?: string
}

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

const MAX_PROMPT = 16_000
const MAX_SECONDS = 366 * 24 * 60 * 60
const MAX_AT_MS = 10 * 366 * 24 * 60 * 60 * 1000
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const SCHEDULE_KEY = /^schedule:(sched_[a-f0-9]{16}):(\d+)$/
const SELECTOR_KEYS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'] as const

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
  db.exec(`CREATE TABLE IF NOT EXISTS schedule_deliveries (
    schedule_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    seq INTEGER,
    reason TEXT,
    job_key TEXT NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS schedule_deliveries_schedule ON schedule_deliveries (schedule_id, at)')
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

function reject(code: ScheduleCode, message?: string): never {
  throw new ScheduleRejected(code, message)
}

function scheduleId(): string {
  return `sched_${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function jobKey(id: string, revision: number): string {
  return `schedule:${id}:${revision}`
}

function assertZone(zone: unknown): string {
  if (typeof zone !== 'string' || zone.length < 1 || zone.length > 64) reject('invalid_time_zone')
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0)
  } catch {
    reject('invalid_time_zone')
  }
  return zone
}

function clockParts(time: unknown): { minute: number; hour: number } {
  if (typeof time !== 'string') reject('invalid_rule')
  const match = TIME.exec(time)
  if (!match) reject('invalid_rule')
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

function whole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function delayFor(schedule: JobSchedule, now: number): number {
  try {
    const next = nextRunAt(schedule, now)
    if (next === null) reject('time_out_of_range')
    return next
  } catch (error) {
    if (error instanceof ScheduleRejected) throw error
    reject('invalid_rule')
  }
}

function compile(
  selector: unknown,
  mode: 'create' | 'update',
  now: number,
): {
  stored: ScheduleSelector
  schedule: JobSchedule
} {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) reject('invalid_selector')
  const record = selector as Record<string, unknown>
  const present = SELECTOR_KEYS.filter((key) => record[key] !== undefined)
  if (present.length !== 1 || Object.keys(record).length !== 1) reject('invalid_selector')
  const kind = present[0]
  if (kind === 'after_seconds') {
    if (mode === 'update') reject('invalid_selector')
    const seconds = whole(record.after_seconds)
    if (seconds === undefined || seconds < 1) reject('invalid_rule')
    if (seconds > MAX_SECONDS) reject('time_out_of_range')
    return {
      stored: { after_seconds: seconds },
      schedule: { kind: 'at', at: now + seconds * 1000 },
    }
  }
  if (kind === 'at') {
    if (typeof record.at !== 'string' || record.at.length < 1 || record.at.length > 64) reject('invalid_rule')
    const at = Date.parse(record.at)
    if (!Number.isFinite(at)) reject('invalid_rule')
    if (at <= now) reject('not_future')
    if (at > now + MAX_AT_MS) reject('time_out_of_range')
    return { stored: { at: record.at }, schedule: { kind: 'at', at } }
  }
  if (kind === 'every_seconds') {
    const seconds = whole(record.every_seconds)
    if (seconds === undefined || seconds < 60) reject('frequency_too_high')
    if (seconds > MAX_SECONDS) reject('time_out_of_range')
    return {
      stored: { every_seconds: seconds },
      schedule: { kind: 'every', everyMs: seconds * 1000, anchorMs: now },
    }
  }
  if (kind === 'daily' || kind === 'weekly') {
    const body = record[kind]
    if (!body || typeof body !== 'object' || Array.isArray(body)) reject('invalid_rule')
    const fields = body as Record<string, unknown>
    const parts = clockParts(fields.time)
    const timeZone = assertZone(fields.timeZone)
    if (kind === 'daily') {
      if (Object.keys(fields).length !== 2) reject('invalid_rule')
      const stored: ScheduleSelector = { daily: { time: fields.time as string, timeZone } }
      return { stored, schedule: { kind: 'cron', expr: `${parts.minute} ${parts.hour} * * *`, tz: timeZone } }
    }
    if (!Array.isArray(fields.weekdays) || Object.keys(fields).length !== 3) reject('invalid_rule')
    const days = [...new Set(fields.weekdays.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b)
    if (
      days.length < 1 ||
      days.length > 7 ||
      days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    )
      reject('invalid_rule')
    const stored: ScheduleSelector = {
      weekly: { time: fields.time as string, timeZone, weekdays: fields.weekdays as number[] },
    }
    return {
      stored,
      schedule: { kind: 'cron', expr: `${parts.minute} ${parts.hour} * * ${days.join(',')}`, tz: timeZone },
    }
  }
  const body = record.cron
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject('invalid_rule')
  const fields = body as Record<string, unknown>
  if (typeof fields.expr !== 'string' || fields.expr.trim().length < 1 || fields.expr.length > 128)
    reject('invalid_rule')
  const expr = fields.expr.trim()
  const timeZone = fields.timeZone === undefined ? undefined : assertZone(fields.timeZone)
  if (Object.keys(fields).length !== (timeZone ? 2 : 1)) reject('invalid_rule')
  const stored: ScheduleSelector = timeZone ? { cron: { expr, timeZone } } : { cron: { expr } }
  return { stored, schedule: timeZone ? { kind: 'cron', expr, tz: timeZone } : { kind: 'cron', expr } }
}

function textField(value: unknown, max: number): string {
  if (typeof value !== 'string') reject('invalid_prompt')
  const text = value.trim()
  if (text.length < 1 || text.length > max) reject('invalid_prompt')
  return text
}

type Compiled = {
  sessionKey: string
  title: string
  prompt: string
  stored: ScheduleSelector
  schedule: JobSchedule
}

function compileWrite(input: ScheduleWrite, mode: 'create' | 'update', now: number): Compiled {
  if (typeof input.sessionKey !== 'string' || input.sessionKey.length < 1 || input.sessionKey.length > 256)
    reject('invalid_selector')
  return {
    sessionKey: input.sessionKey,
    title: textField(input.title, 120),
    prompt: textField(input.prompt, MAX_PROMPT),
    ...compile(input.selector, mode, now),
  }
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

export type ScheduleCatalog = {
  create(input: ScheduleWrite): ScheduleView
  update(input: ScheduleWrite & { id: string }): ScheduleView | { updated: false; code: ScheduleCode }
  archive(id: string): { deleted: boolean }
  list(query: { sessionKey?: string; includeArchived?: boolean; limit?: number }): ScheduleView[]
  read(id: string): ScheduleView | undefined
  recordDispatch(jobKey: string, info: { at: number; seq?: number; reason?: string }): void
  noteSettlement(jobKey: string, info: { nextRunAt: number | null }): void
  stillWaiting(jobKey: string): boolean
  recentDelivery(sessionKey: string, since: number): { title: string; prompt: string } | undefined
}

export function openScheduleCatalog(db: ScheduleDb, clock: () => number = () => Date.now()): ScheduleCatalog {
  ensureScheduleSchema(db)
  const load = (id: string): ScheduleRow | undefined =>
    db.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', [id])
  const deliveries = (id: string): ScheduleDelivery[] =>
    db
      .all<{ at: number; seq: number | null; reason: string | null }>(
        `SELECT at, seq, reason FROM (
           SELECT at, seq, reason, rowid AS rid FROM schedule_deliveries
           WHERE schedule_id = ? ORDER BY at DESC, rowid DESC LIMIT 20
         ) ORDER BY at ASC, rid ASC`,
        [id],
      )
      .map((row) => ({
        at: row.at,
        ...(row.seq === null ? {} : { seq: row.seq }),
        ...(row.reason === null ? {} : { reason: row.reason }),
      }))
  const viewOf = (row: ScheduleRow): ScheduleView => ({
    id: row.id,
    sessionKey: row.session_key,
    title: row.title,
    prompt: row.prompt,
    selector: JSON.parse(row.selector) as ScheduleSelector,
    status: row.status,
    nextRunAt: row.next_run_at,
    revision: row.revision,
    deliveries: deliveries(row.id),
  })
  const read = (id: string): ScheduleView | undefined => {
    const row = load(id)
    return row ? viewOf(row) : undefined
  }
  return {
    create(input) {
      const now = clock()
      const compiled = compileWrite(input, 'create', now)
      const id = scheduleId()
      const key = jobKey(id, 1)
      const delay = delayFor(compiled.schedule, now)
      db.transaction(() => {
        insertJob(db, key, compiled.sessionKey, compiled.prompt, compiled.schedule, delay, now)
        db.exec(
          `INSERT INTO schedules (
             id, session_key, title, prompt, selector, status, job_key, revision, next_run_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, ?)`,
          [
            id,
            compiled.sessionKey,
            compiled.title,
            compiled.prompt,
            JSON.stringify(compiled.stored),
            key,
            delay,
            now,
            now,
          ],
        )
      })
      const created = read(id)
      if (!created) reject('internal_error')
      return created
    },
    update(input) {
      const now = clock()
      const row = load(input.id)
      if (!row || row.session_key !== input.sessionKey) return { updated: false, code: 'schedule_not_found' }
      if (row.status !== 'active') return { updated: false, code: 'schedule_ended' }
      const compiled = compileWrite(input, 'update', now)
      const stored = JSON.stringify(compiled.stored)
      const promptChanged = compiled.prompt !== row.prompt
      const selectorChanged = stored !== row.selector
      const status = jobStatus(db, row.job_key)
      if (status === 'active' && (promptChanged || selectorChanged))
        return { updated: false, code: 'schedule_conflict' }
      db.transaction(() => {
        let key = row.job_key
        let revision = row.revision
        let next = row.next_run_at
        if (status === 'active') {
          db.exec("UPDATE schedules SET title = ?, updated_at = ? WHERE id = ? AND status = 'active'", [
            compiled.title,
            now,
            row.id,
          ])
          return
        }
        if (selectorChanged || (promptChanged && status !== 'waiting' && status !== 'delayed')) {
          cancelQueued(db, key, now)
          revision += 1
          key = jobKey(row.id, revision)
          next = delayFor(compiled.schedule, now)
          insertJob(db, key, compiled.sessionKey, compiled.prompt, compiled.schedule, next, now)
        } else if (promptChanged && key) {
          db.exec(
            `UPDATE jobs SET payload = ?, updated_at = ? WHERE idempotency_key = ? AND status IN ('waiting', 'delayed')`,
            [JSON.stringify({ prompt: compiled.prompt }), now, key],
          )
        }
        db.exec(
          `UPDATE schedules
           SET title = ?, prompt = ?, selector = ?, job_key = ?, revision = ?, next_run_at = ?, updated_at = ?
           WHERE id = ? AND status = 'active'`,
          [compiled.title, compiled.prompt, stored, key, revision, next, now, row.id],
        )
      })
      const updated = read(input.id)
      if (updated?.status !== 'active') return { updated: false, code: 'schedule_ended' }
      return updated
    },
    archive(id) {
      const row = load(id)
      if (row?.status !== 'active') return { deleted: false }
      const now = clock()
      const status = jobStatus(db, row.job_key)
      db.transaction(() => {
        if (status === 'waiting' || status === 'delayed') cancelQueued(db, row.job_key, now)
        db.exec(
          `UPDATE schedules SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`,
          [now, id],
        )
      })
      return { deleted: true }
    },
    list(query) {
      const limit = Math.min(query.limit ?? 500, 500)
      return db
        .all<ScheduleRow>(
          `SELECT * FROM schedules
           WHERE (? IS NULL OR session_key = ?) AND (? = 1 OR status = 'active')
           ORDER BY COALESCE(next_run_at, 9223372036854775807), id LIMIT ?`,
          [query.sessionKey ?? null, query.sessionKey ?? null, query.includeArchived ? 1 : 0, limit],
        )
        .map(viewOf)
    },
    read,
    recordDispatch(key, info) {
      const id = SCHEDULE_KEY.exec(key)?.[1]
      if (!id || !load(id)) return
      db.transaction(() => {
        db.exec(
          'INSERT INTO schedule_deliveries (schedule_id, at, seq, reason, job_key) VALUES (?, ?, ?, ?, ?)',
          [id, info.at, info.seq ?? null, info.reason ?? null, key],
        )
        db.exec(
          `DELETE FROM schedule_deliveries WHERE schedule_id = ? AND rowid NOT IN (
             SELECT rowid FROM schedule_deliveries WHERE schedule_id = ? ORDER BY at DESC, rowid DESC LIMIT 50
           )`,
          [id, id],
        )
      })
    },
    noteSettlement(key, info) {
      const id = SCHEDULE_KEY.exec(key)?.[1]
      if (!id) return
      const now = clock()
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
    stillWaiting(key) {
      const id = SCHEDULE_KEY.exec(key)?.[1]
      if (!id) return true
      return load(id)?.status === 'active'
    },
    recentDelivery(sessionKey, since) {
      return db.get<{ title: string; prompt: string }>(
        `SELECT s.title AS title, s.prompt AS prompt FROM schedule_deliveries d
         JOIN schedules s ON s.id = d.schedule_id
         WHERE s.session_key = ? AND d.at >= ? ORDER BY d.at DESC LIMIT 1`,
        [sessionKey, since],
      )
    },
  }
}

export function createSchedulesPort(db: ScheduleDb, clock: () => number = () => Date.now()) {
  const catalog = openScheduleCatalog(db, clock)
  return {
    list(params: { scope: 'session' | 'all'; sessionKey?: string; includeArchived?: boolean }) {
      return Promise.resolve({
        schedules: catalog.list({
          ...(params.scope === 'session' ? { sessionKey: params.sessionKey } : {}),
          includeArchived: params.includeArchived === true,
        }),
      })
    },
    upsert(params: unknown) {
      const body = params as ScheduleWrite
      return Promise.resolve(body.id ? catalog.update({ ...body, id: body.id }) : catalog.create(body))
    },
    archive(params: { id: string }) {
      return Promise.resolve(catalog.archive(params.id))
    },
    read(id: string) {
      const row = catalog.read(id)
      return Promise.resolve(row ? { sessionKey: row.sessionKey } : undefined)
    },
    recordDispatch: catalog.recordDispatch,
    noteSettlement: catalog.noteSettlement,
    stillWaiting: catalog.stillWaiting,
  }
}
