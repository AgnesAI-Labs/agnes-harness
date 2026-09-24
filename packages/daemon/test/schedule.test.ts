import { describe, expect, it } from 'vitest'
import { cronMatches, nextAfterCompletion, nextRunAt, parseCron } from '../src/jobs/schedule.js'

const timestamp = (value: string) => Date.parse(value)

describe('job schedules', () => {
  it('parses cron fields with ranges, lists, and steps', () => {
    const weekdays = parseCron('0 9 * * 1-5')
    expect(cronMatches(weekdays, new Date(timestamp('2026-09-07T09:00:00Z')))).toBe(true)
    expect(cronMatches(weekdays, new Date(timestamp('2026-09-06T09:00:00Z')))).toBe(false)
    expect(cronMatches(parseCron('0,15,30,45 * * * *'), new Date(timestamp('2026-09-07T10:45:00Z')))).toBe(
      true,
    )
    expect(cronMatches(parseCron('10-50/20 * * * *'), new Date(timestamp('2026-09-07T10:30:00Z')))).toBe(true)
    expect(() => parseCron('61 * * * *')).toThrow(/E_CRON/)
    expect(() => parseCron('* * *')).toThrow(/E_CRON/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/E_CRON/)
  })

  it('treats weekday 7 as Sunday and honours IANA time zones', () => {
    expect(cronMatches(parseCron('0 12 * * 7'), new Date(timestamp('2026-09-06T12:00:00Z')))).toBe(true)
    const morning = parseCron('30 8 * * *')
    expect(cronMatches(morning, new Date(timestamp('2026-09-07T00:30:00Z')), 'Asia/Shanghai')).toBe(true)
    expect(cronMatches(morning, new Date(timestamp('2026-09-07T08:30:00Z')), 'Asia/Shanghai')).toBe(false)
    expect(() => cronMatches(morning, new Date(), 'Not/AZone')).toThrow(/E_CRON/)
  })

  it('computes next runs for all four schedule kinds', () => {
    const now = timestamp('2026-09-07T10:00:30Z')
    expect(nextRunAt({ kind: 'once' }, now)).toBe(now)
    expect(nextRunAt({ kind: 'at', at: now + 5_000 }, now)).toBe(now + 5_000)
    expect(nextRunAt({ kind: 'at', at: now - 5_000 }, now)).toBe(now)
    expect(
      nextRunAt({ kind: 'every', everyMs: 60_000, anchorMs: timestamp('2026-09-07T10:00:00Z') }, now),
    ).toBe(timestamp('2026-09-07T10:01:00Z'))
    expect(nextRunAt({ kind: 'cron', expr: '0 9 * * *' }, now)).toBe(timestamp('2026-09-08T09:00:00Z'))
    expect(nextRunAt({ kind: 'cron', expr: '0 9 * * *', staggerMs: 1_000 }, now, { random: () => 0.5 })).toBe(
      timestamp('2026-09-08T09:00:00Z') + 500,
    )
    expect(nextAfterCompletion({ kind: 'once' }, now)).toBeNull()
    expect(nextAfterCompletion({ kind: 'every', everyMs: 1_000 }, now)).toBe(now + 1_000)
  })

  it('rejects invalid every intervals and invalid random values', () => {
    expect(() => nextRunAt({ kind: 'every', everyMs: 0 }, 0)).toThrow(/E_SCHEDULE/)
    expect(() => nextRunAt({ kind: 'cron', expr: '* * * * *', staggerMs: -1 }, 0)).toThrow(/E_SCHEDULE/)
    expect(() =>
      nextRunAt({ kind: 'cron', expr: '* * * * *', staggerMs: 100 }, 0, { random: () => 2 }),
    ).toThrow(/E_SCHEDULE/)
  })
})
