import type { ScheduleRun } from './schedule-model.js'

export type Text = (key: string, vars?: Record<string, string | number>) => string

const KINDS = ['at', 'every_seconds', 'daily', 'weekly', 'cron', 'after_seconds'] as const
export type SelectorKind = (typeof KINDS)[number]
export const selectorKind = (selector: Record<string, unknown>): SelectorKind | undefined =>
  KINDS.find((item) => item in selector)

/** Tasks run in this computer's time zone unless the user names another one. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

const lang = () => (typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en')

export const moment = (value: number | string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString(lang(), { dateStyle: 'medium', timeStyle: 'short' })
}

/** "today 09:00", "tomorrow 09:00", or the date and time. */
export function when(at: number, ux: Text, now = Date.now()): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return String(at)
  const time = date.toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit', hour12: false })
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((day(date) - day(new Date(now))) / 86_400_000)
  if (days === 0) return ux('today', { time })
  if (days === 1) return ux('tomorrow', { time })
  return moment(at)
}

export function duration(seconds: number, ux: Text): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return String(seconds)
  if (seconds % 3600 === 0) return ux('hours', { count: seconds / 3600 })
  if (seconds % 60 === 0) return ux('minutes', { count: seconds / 60 })
  return ux('seconds', { count: seconds })
}

/** How long a run took, rounded for reading: "42 s", "3 min", "2 h". */
export function runDuration(run: ScheduleRun, ux: Text): string | undefined {
  if (run.endedAt === undefined || run.endedAt < run.at) return undefined
  const seconds = Math.max(1, Math.round((run.endedAt - run.at) / 1000))
  if (seconds < 60) return ux('seconds', { count: seconds })
  if (seconds < 3600) return ux('minutes', { count: Math.round(seconds / 60) })
  return ux('hours', { count: Math.round(seconds / 360) / 10 })
}

/** A schedule's rule in words: "Daily 09:00", "Weekly Fri 17:30", "Every 30 minutes". */
export function describeSchedule(selector: Record<string, unknown>, t: Text, ux: Text): string {
  const kind = selectorKind(selector)
  if (!kind) return ''
  const value = selector[kind]
  const fields = (value && typeof value === 'object' ? value : {}) as {
    time?: string
    weekdays?: number[]
    expr?: string
  }
  if (kind === 'daily') return `${t('schedulesKind.daily')} ${fields.time ?? ''}`.trim()
  if (kind === 'weekly')
    return [
      t('schedulesKind.weekly'),
      (fields.weekdays ?? [])
        .map((day) => t(`schedulesDay.${day === 7 ? 0 : day}`))
        .join(ux('listSeparator')),
      fields.time,
    ]
      .filter(Boolean)
      .join(' ')
  if (kind === 'cron') return `${t('schedulesKind.cron')} ${fields.expr ?? ''}`.trim()
  if (kind === 'at') return `${t('schedulesKind.at')} ${moment(String(value))}`
  return ux(kind === 'every_seconds' ? 'ruleEvery' : 'ruleAfter', { duration: duration(Number(value), ux) })
}

/**
 * When a rule would next run, counted from `now` in this computer's time zone. Undefined for a Cron
 * expression or another time zone, where the daemon's answer after saving is the reliable one.
 */
export function nextRun(
  selector: Record<string, unknown>,
  now: number,
  zone = localTimeZone(),
): number | undefined {
  const kind = selectorKind(selector)
  const value = kind ? selector[kind] : undefined
  if (kind === 'after_seconds' || kind === 'every_seconds') {
    const seconds = Number(value)
    return Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : undefined
  }
  if (kind === 'at') {
    const at = Date.parse(String(value))
    return Number.isFinite(at) && at > now ? at : undefined
  }
  if (kind !== 'daily' && kind !== 'weekly') return undefined
  const fields = value as { time?: string; timeZone?: string; weekdays?: number[] }
  if (fields.timeZone && fields.timeZone !== zone) return undefined
  const match = /^(\d{2}):(\d{2})$/.exec(fields.time ?? '')
  if (!match) return undefined
  const days = new Set((fields.weekdays ?? [0, 1, 2, 3, 4, 5, 6]).map((day) => (day === 7 ? 0 : day)))
  if (kind === 'weekly' && days.size === 0) return undefined
  const start = new Date(now)
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + offset,
      Number(match[1]),
      Number(match[2]),
    )
    if (candidate.getTime() > now && (kind === 'daily' || days.has(candidate.getDay())))
      return candidate.getTime()
  }
  return undefined
}

/** `YYYY-MM-DDTHH:mm` for a datetime-local input, in this computer's time. */
export function localInput(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A datetime-local value as an ISO time with this computer's offset, which the daemon parses. */
export function isoFromLocal(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

/** Reasons the daemon names; anything else reads as the plain failure word. */
const REASONS = new Set([
  'workspace_missing',
  'loop_missing',
  'bundle_unavailable',
  'preset_not_allowed',
  'model_missing',
  'session_unavailable',
  'start_failed',
  'turn_error',
  'interrupted',
  'invalid_target',
  'not_future',
  'frequency_too_high',
  'invalid_rule',
  'invalid_time_zone',
  'time_out_of_range',
  'schedule_running',
  'schedule_paused',
  'schedule_ended',
  'schedule_conflict',
  'needs_attention',
  'approval_expired',
  'previous_approval_expired',
  'approval_refused',
  'approval_unavailable',
  'approval_pending_previous_run',
])
export const reasonText = (code: string | undefined, ux: Text): string | undefined =>
  code && REASONS.has(code) ? ux(`reason.${code}`) : undefined

/** The code inside a refused result or a SEMANTIC_REJECTED error, when there is one. */
export function codeOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { code?: unknown; data?: { code?: unknown }; details?: { code?: unknown } }
  for (const code of [record.data?.code, record.details?.code, record.code])
    if (typeof code === 'string' && REASONS.has(code)) return code
  return undefined
}
