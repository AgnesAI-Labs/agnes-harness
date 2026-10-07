// Five-field cron shared by daemon Jobs and the schedule tools.
// Day-of-month and day-of-week follow Vixie: a field is unrestricted when its text starts with
// `*` (`*` and `*/2` are unrestricted; `1-31` and `0-7` are restricted). When both day fields are
// restricted, a date matches if either one matches. Otherwise every field matches (AND).
// Weekday 7 is Sunday. A zoned expression skips a local time that does not exist (spring-forward)
// and fires a repeated local time once, at the earlier instant (fall-back). The search horizon is
// 366 days.

export type CronSpec = {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
  dayStar: boolean
  weekdayStar: boolean
}

export type JobSchedule =
  | { kind: 'once' }
  | { kind: 'at'; at: number }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string; staggerMs?: number }

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const

function cronError(message: string): Error {
  return new Error(`E_CRON: ${message}`)
}

function scheduleError(message: string): Error {
  return new Error(`E_SCHEDULE: ${message}`)
}

function parseField(source: string, range: readonly [number, number]): Set<number> {
  const [minimum, maximum] = range
  const values = new Set<number>()
  for (const part of source.split(',')) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part)
    if (!match) throw cronError(`bad field ${part}`)
    const start = match[1] === '*' ? minimum : Number(match[1])
    const end = match[1] === '*' ? maximum : match[2] === undefined ? start : Number(match[2])
    const step = match[3] === undefined ? 1 : Number(match[3])
    if (start < minimum || end > maximum || start > end || step < 1) throw cronError(`out of range ${part}`)
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw cronError('expected 5 fields')
  const minute = parseField(fields[0] ?? '', RANGES[0])
  const hour = parseField(fields[1] ?? '', RANGES[1])
  const day = parseField(fields[2] ?? '', RANGES[2])
  const month = parseField(fields[3] ?? '', RANGES[3])
  const weekday = parseField(fields[4] ?? '', RANGES[4])
  if (weekday.has(7)) weekday.add(0)
  return {
    minute,
    hour,
    day,
    month,
    weekday,
    dayStar: (fields[2] ?? '').startsWith('*'),
    weekdayStar: (fields[4] ?? '').startsWith('*'),
  }
}

type Parts = { year: number; minute: number; hour: number; day: number; month: number; weekday: number }

function dateParts(date: Date, timeZone?: string): Parts {
  if (!timeZone) {
    return {
      year: date.getUTCFullYear(),
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay(),
    }
  }
  let formatted: Intl.DateTimeFormatPart[]
  try {
    formatted = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      minute: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
      day: 'numeric',
      month: 'numeric',
      weekday: 'short',
    }).formatToParts(date)
  } catch {
    throw cronError(`invalid time zone ${timeZone}`)
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => formatted.find((item) => item.type === type)?.value
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday') ?? '')
  if (weekday < 0) throw cronError(`cannot resolve time zone ${timeZone}`)
  return {
    year: Number(part('year')),
    minute: Number(part('minute')),
    hour: Number(part('hour')),
    day: Number(part('day')),
    month: Number(part('month')),
    weekday,
  }
}

function localKey(parts: Parts): string {
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

export function cronMatches(spec: CronSpec, date: Date, timeZone?: string): boolean {
  const parts = dateParts(date, timeZone)
  const dayHit = spec.day.has(parts.day)
  const weekHit = spec.weekday.has(parts.weekday)
  const days = spec.dayStar || spec.weekdayStar ? dayHit && weekHit : dayHit || weekHit
  if (!(spec.minute.has(parts.minute) && spec.hour.has(parts.hour) && spec.month.has(parts.month) && days))
    return false
  if (!timeZone) return true
  const key = localKey(parts)
  for (let back = 60_000; back <= 3 * 60 * 60_000; back += 60_000) {
    if (localKey(dateParts(new Date(date.getTime() - back), timeZone)) === key) return false
  }
  return true
}

type NextRunOptions = { anchorMs?: number; staggerMs?: number; random?: () => number }

export function nextRunAt(schedule: JobSchedule, now: number, options: NextRunOptions = {}): number | null {
  switch (schedule.kind) {
    case 'once':
      return now
    case 'at':
      return Math.max(schedule.at, now)
    case 'every': {
      if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs <= 0)
        throw scheduleError('everyMs must be a positive safe integer')
      const anchor = options.anchorMs ?? schedule.anchorMs ?? now
      if (anchor > now) return anchor
      return anchor + (Math.floor((now - anchor) / schedule.everyMs) + 1) * schedule.everyMs
    }
    case 'cron': {
      const staggerMs = options.staggerMs ?? schedule.staggerMs ?? 0
      if (!Number.isSafeInteger(staggerMs) || staggerMs < 0)
        throw scheduleError('staggerMs must be a non-negative safe integer')
      const random = options.random ?? Math.random
      const spec = parseCron(schedule.expr)
      const firstMinute = Math.floor(now / 60_000) * 60_000 + 60_000
      const lastMinute = firstMinute + 366 * 24 * 60 * 60_000
      for (let candidate = firstMinute; candidate <= lastMinute; candidate += 60_000) {
        if (!cronMatches(spec, new Date(candidate), schedule.tz)) continue
        const sample = random()
        if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
          throw scheduleError('random must return a value in [0, 1)')
        return candidate + Math.floor(sample * staggerMs)
      }
      return null
    }
  }
}

export function nextAfterCompletion(
  schedule: JobSchedule,
  completedAt: number,
  options: NextRunOptions = {},
): number | null {
  return schedule.kind === 'once' || schedule.kind === 'at' ? null : nextRunAt(schedule, completedAt, options)
}
