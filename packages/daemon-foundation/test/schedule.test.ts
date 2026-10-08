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

  it('matches a restricted day-of-month or day-of-week, and either one when both are restricted', () => {
    const thirteenth = parseCron('0 0 13 * *')
    expect(cronMatches(thirteenth, new Date(timestamp('2026-09-13T00:00:00Z')))).toBe(true)
    expect(cronMatches(thirteenth, new Date(timestamp('2026-09-12T00:00:00Z')))).toBe(false)
    const friday = parseCron('0 0 * * 5')
    expect(cronMatches(friday, new Date(timestamp('2026-09-04T00:00:00Z')))).toBe(true)
    expect(cronMatches(friday, new Date(timestamp('2026-09-03T00:00:00Z')))).toBe(false)
    const either = parseCron('30 4 1,15 * 5')
    expect(nextRunAt({ kind: 'cron', expr: '30 4 1,15 * 5' }, timestamp('2026-08-31T00:00:00Z'))).toBe(
      timestamp('2026-09-01T04:30:00Z'),
    )
    expect(cronMatches(either, new Date(timestamp('2026-09-04T04:30:00Z')))).toBe(true)
    expect(nextRunAt({ kind: 'cron', expr: '30 4 * * 5' }, timestamp('2026-08-31T00:00:00Z'))).toBe(
      timestamp('2026-09-04T04:30:00Z'),
    )
    expect(cronMatches(parseCron('0 0 1-31 * 5'), new Date(timestamp('2026-09-02T00:00:00Z')))).toBe(true)
  })

  it('skips a missing local time and fires a repeated local time at the earlier instant', () => {
    const oneThirty = parseCron('30 1 * * *')
    expect(cronMatches(oneThirty, new Date(timestamp('2026-11-01T05:30:00Z')), 'America/New_York')).toBe(true)
    expect(cronMatches(oneThirty, new Date(timestamp('2026-11-01T06:30:00Z')), 'America/New_York')).toBe(
      false,
    )
    expect(
      nextRunAt(
        { kind: 'cron', expr: '30 1 * * *', tz: 'America/New_York' },
        timestamp('2026-11-01T05:00:00Z'),
      ),
    ).toBe(timestamp('2026-11-01T05:30:00Z'))
    expect(
      nextRunAt(
        { kind: 'cron', expr: '30 2 * * *', tz: 'America/New_York' },
        timestamp('2026-03-08T06:00:00Z'),
      ),
    ).toBe(timestamp('2026-03-09T06:30:00Z'))
  })

  it('rejects invalid every intervals and invalid random values', () => {
    expect(() => nextRunAt({ kind: 'every', everyMs: 0 }, 0)).toThrow(/E_SCHEDULE/)
    expect(() => nextRunAt({ kind: 'cron', expr: '* * * * *', staggerMs: -1 }, 0)).toThrow(/E_SCHEDULE/)
    expect(() =>
      nextRunAt({ kind: 'cron', expr: '* * * * *', staggerMs: 100 }, 0, { random: () => 2 }),
    ).toThrow(/E_SCHEDULE/)
  })
})
