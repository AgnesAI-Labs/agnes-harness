import { type JobSchedule, nextRunAt } from '../../../src/schedule-cron.js'

export type ScheduleCode =
  | 'invalid_prompt'
  | 'invalid_selector'
  | 'invalid_target'
  | 'invalid_rule'
  | 'invalid_time_zone'
  | 'not_future'
  | 'time_out_of_range'
  | 'frequency_too_high'
  | 'subagent_session'
  | 'internal_error'
  | 'schedule_not_found'
  | 'schedule_ended'
  | 'schedule_paused'
  | 'schedule_running'
  | 'schedule_conflict'
  // A new-session target that does not resolve on this computer; also recorded as a run's reason.
  | 'workspace_missing'
  | 'loop_missing'
  | 'bundle_unavailable'
  | 'preset_not_allowed'
  | 'model_missing'

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

/** Where a task runs: one existing session, or a fresh session per run in a registered workspace. */
export type ScheduleTarget =
  | { kind: 'session'; sessionKey: string; unattendedApproval?: 'notify' | 'refuse' }
  | {
      kind: 'new-session'
      cwd: string
      unattendedApproval?: 'notify' | 'refuse'
      loop?: { id: string; version: string }
      bundles?: string[]
      preset?: string
      model?: { route: string; model: string }
    }
export type NewSessionTarget = Extract<ScheduleTarget, { kind: 'new-session' }>

export type ScheduleRunOutcome =
  | 'running'
  | 'waiting_approval'
  | 'needs_attention'
  | 'ran'
  | 'delivered'
  | 'failed'
export type ScheduleRun = {
  at: number
  outcome: ScheduleRunOutcome
  needsAttention?: boolean
  sessionKey?: string
  endedAt?: number
  seq?: number
  reason?: string
  detail?: string
}
export type ScheduleStatus = 'active' | 'paused' | 'archived' | 'ended'
export type ScheduleView = {
  id: string
  title: string
  prompt: string
  selector: ScheduleSelector
  target: ScheduleTarget
  origin?: string
  status: ScheduleStatus
  nextRunAt: number | null
  revision: number
  runs: ScheduleRun[]
}
export type ScheduleWrite = {
  title: string
  prompt: string
  selector: unknown
  /** Omitted: the origin session on create, the current target on update. */
  target?: unknown
  /** The session creating the task; a session target defaults to it. */
  origin?: string | undefined
  id?: string
  /** When set, only a task created by or bound to this session may change. */
  owner?: string
}

export const MAX_PROMPT = 16_000
const MAX_SECONDS = 366 * 24 * 60 * 60
const MAX_AT_MS = 10 * 366 * 24 * 60 * 60 * 1000
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const SELECTOR_KEYS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'] as const

export function reject(code: ScheduleCode, message?: string): never {
  throw new ScheduleRejected(code, message)
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

export function delayFor(schedule: JobSchedule, now: number): number {
  try {
    const next = nextRunAt(schedule, now)
    if (next === null) reject('time_out_of_range')
    return next
  } catch (error) {
    if (error instanceof ScheduleRejected) throw error
    reject('invalid_rule')
  }
}

export function compile(
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

export function textField(value: unknown, max: number): string {
  if (typeof value !== 'string') reject('invalid_prompt')
  const text = value.trim()
  if (text.length < 1 || text.length > max) reject('invalid_prompt')
  return text
}

const control = (text: string) =>
  Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })
function name(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || control(value))
    reject('invalid_target')
  return value
}

function exact(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) reject('invalid_target')
}

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_target')
  return value as Record<string, unknown>
}

/** Shape only. Whether the workspace, loop, bundles, preset and model exist is the daemon's check. */
export function compileTarget(value: unknown, origin?: string): ScheduleTarget {
  if (value === undefined && origin) return { kind: 'session', sessionKey: origin }
  const record = plain(value)
  if (
    record.unattendedApproval !== undefined &&
    !['notify', 'refuse'].includes(String(record.unattendedApproval))
  )
    reject('invalid_target')
  const approval =
    record.unattendedApproval === 'refuse'
      ? { unattendedApproval: 'refuse' as const }
      : record.unattendedApproval === 'notify'
        ? { unattendedApproval: 'notify' as const }
        : {}
  if (record.kind === 'session') {
    exact(record, ['kind', 'sessionKey', 'unattendedApproval'])
    return { kind: 'session', sessionKey: name(record.sessionKey, 256), ...approval }
  }
  if (record.kind !== 'new-session') reject('invalid_target')
  exact(record, ['kind', 'cwd', 'loop', 'bundles', 'preset', 'model', 'unattendedApproval'])
  const target: NewSessionTarget = { kind: 'new-session', cwd: name(record.cwd, 4096), ...approval }
  if (record.loop !== undefined) {
    const loop = plain(record.loop)
    exact(loop, ['id', 'version'])
    target.loop = { id: name(loop.id, 256), version: name(loop.version, 256) }
  }
  if (record.bundles !== undefined) {
    if (!Array.isArray(record.bundles) || record.bundles.length > 64) reject('invalid_target')
    const bundles = record.bundles.map((bundle) => name(bundle, 512))
    if (new Set(bundles).size !== bundles.length) reject('invalid_target')
    if (bundles.length) target.bundles = bundles
  }
  if (record.preset !== undefined) target.preset = name(record.preset, 128)
  if (record.model !== undefined) {
    const model = plain(record.model)
    exact(model, ['route', 'model'])
    target.model = { route: name(model.route, 256), model: name(model.model, 256) }
  }
  return target
}
