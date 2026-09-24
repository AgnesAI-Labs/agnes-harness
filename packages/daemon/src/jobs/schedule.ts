import type { JobSchedule } from './repo.js'

export type CronSpec = {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
}

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
    if (start < minimum || end > maximum || start > end || step < 1) {
      throw cronError(`out of range ${part}`)
    }
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
  return { minute, hour, day, month, weekday }
}

function dateParts(date: Date, timeZone?: string) {
  if (!timeZone) {
    return {
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
    minute: Number(part('minute')),
    hour: Number(part('hour')),
    day: Number(part('day')),
    month: Number(part('month')),
    weekday,
  }
}

export function cronMatches(spec: CronSpec, date: Date, timeZone?: string): boolean {
  const parts = dateParts(date, timeZone)
  return (
    spec.minute.has(parts.minute) &&
    spec.hour.has(parts.hour) &&
    spec.day.has(parts.day) &&
    spec.month.has(parts.month) &&
    spec.weekday.has(parts.weekday)
  )
}

type NextRunOptions = { anchorMs?: number; staggerMs?: number; random?: () => number }

export function nextRunAt(schedule: JobSchedule, now: number, options: NextRunOptions = {}): number | null {
  switch (schedule.kind) {
    case 'once':
      return now
    case 'at':
      return Math.max(schedule.at, now)
    case 'every': {
      if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs <= 0) {
        throw scheduleError('everyMs must be a positive safe integer')
      }
      const anchor = options.anchorMs ?? schedule.anchorMs ?? now
      if (anchor > now) return anchor
      return anchor + (Math.floor((now - anchor) / schedule.everyMs) + 1) * schedule.everyMs
    }
    case 'cron': {
      const staggerMs = options.staggerMs ?? schedule.staggerMs ?? 0
      if (!Number.isSafeInteger(staggerMs) || staggerMs < 0) {
        throw scheduleError('staggerMs must be a non-negative safe integer')
      }
      const random = options.random ?? Math.random
      const spec = parseCron(schedule.expr)
      const firstMinute = Math.floor(now / 60_000) * 60_000 + 60_000
      const lastMinute = firstMinute + 366 * 24 * 60 * 60_000
      for (let candidate = firstMinute; candidate <= lastMinute; candidate += 60_000) {
        if (!cronMatches(spec, new Date(candidate), schedule.tz)) continue
        const sample = random()
        if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
          throw scheduleError('random must return a value in [0, 1)')
        }
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
