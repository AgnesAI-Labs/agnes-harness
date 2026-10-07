import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openScheduleCatalog, type ScheduleDb, ScheduleRejected, type ScheduleView } from '../src/catalog.js'

const NOW = Date.parse('2026-09-07T00:00:00Z')

function memory(now = NOW) {
  const db = new DatabaseSync(':memory:')
  const sql: ScheduleDb = {
    exec(statement, params) {
      const bound = (params ?? []) as SQLInputValue[]
      if (bound.length > 0) db.prepare(statement).run(...bound)
      else db.exec(statement)
    },
    get(statement, params) {
      return db.prepare(statement).get(...((params ?? []) as SQLInputValue[])) as never
    },
    all(statement, params) {
      return db.prepare(statement).all(...((params ?? []) as SQLInputValue[])) as never
    },
    transaction(fn) {
      db.exec('BEGIN')
      try {
        const value = fn()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  return { db, catalog: openScheduleCatalog(sql, () => now) }
}

function daily(sessionKey = 'sess') {
  return {
    sessionKey,
    title: 'Standup',
    prompt: 'Check mail',
    selector: { daily: { time: '09:00', timeZone: 'UTC' } },
  }
}

function job(db: DatabaseSync, id: string) {
  return db
    .prepare('SELECT status, payload, schedule FROM jobs WHERE idempotency_key LIKE ?')
    .get(`schedule:${id}:%`) as { status: string; payload: string; schedule: string }
}

it('creates a daily reminder, lists it, and accepts a title change', () => {
  const { catalog } = memory()
  const created = catalog.create(daily())
  expect(created.id).toMatch(/^sched_[a-f0-9]{16}$/)
  expect(created.nextRunAt).toBe(Date.parse('2026-09-07T09:00:00Z'))
  expect(catalog.list({ sessionKey: 'sess' }).map((row) => row.id)).toEqual([created.id])
  expect(catalog.list({ sessionKey: 'other' })).toEqual([])
  const renamed = catalog.update({ ...daily(), id: created.id, title: 'Morning' })
  expect(renamed).toMatchObject({ title: 'Morning', prompt: 'Check mail', revision: 1 })
})

it('rejects a past time, a short interval, and after_seconds on update', () => {
  const { catalog } = memory()
  expect(() => catalog.create({ ...daily(), selector: { at: '2020-01-01T00:00:00Z' } })).toThrow(
    ScheduleRejected,
  )
  expect(() => catalog.create({ ...daily(), selector: { every_seconds: 30 } })).toThrowError(
    expect.objectContaining({ code: 'frequency_too_high' }),
  )
  const created = catalog.create(daily())
  expect(() => catalog.update({ ...daily(), id: created.id, selector: { after_seconds: 90 } })).toThrowError(
    expect.objectContaining({ code: 'invalid_selector' }),
  )
})

it('stores a trimmed cron expression and the Vixie day-field match', () => {
  const { catalog } = memory(Date.parse('2026-08-31T00:00:00Z'))
  const created = catalog.create({
    ...daily(),
    selector: { cron: { expr: '  30 4 1,15 * 5  ', timeZone: 'UTC' } },
  })
  expect(created.selector).toEqual({ cron: { expr: '30 4 1,15 * 5', timeZone: 'UTC' } })
  expect(created.nextRunAt).toBe(Date.parse('2026-09-01T04:30:00Z'))
})

it('refuses a prompt change while the job is active and still updates the title', () => {
  const { db, catalog } = memory()
  const created = catalog.create(daily())
  db.prepare(`UPDATE jobs SET status = 'active' WHERE idempotency_key LIKE ?`).run(`schedule:${created.id}:%`)
  expect(catalog.update({ ...daily(), id: created.id, prompt: 'Other' })).toEqual({
    updated: false,
    code: 'schedule_conflict',
  })
  const titled = catalog.update({ ...daily(), id: created.id, title: 'Later' }) as ScheduleView
  expect(titled.title).toBe('Later')
  expect(titled.prompt).toBe('Check mail')
  expect(job(db, created.id).status).toBe('active')
})

it('cancels a waiting job on archive and leaves an in-flight job running', () => {
  const waiting = memory()
  const queued = waiting.catalog.create(daily())
  expect(waiting.catalog.archive(queued.id)).toEqual({ deleted: true })
  expect(job(waiting.db, queued.id).status).toBe('cancelled')
  expect(waiting.catalog.stillWaiting(`schedule:${queued.id}:1`)).toBe(false)
  expect(waiting.catalog.archive(queued.id)).toEqual({ deleted: false })

  const live = memory()
  const running = live.catalog.create(daily())
  live.db
    .prepare(`UPDATE jobs SET status = 'active' WHERE idempotency_key LIKE ?`)
    .run(`schedule:${running.id}:%`)
  expect(live.catalog.archive(running.id)).toEqual({ deleted: true })
  expect(job(live.db, running.id).status).toBe('active')
  expect(live.catalog.stillWaiting(`schedule:${running.id}:1`)).toBe(false)
  live.catalog.noteSettlement(`schedule:${running.id}:1`, { nextRunAt: NOW + 86_400_000 })
  expect(live.catalog.read(running.id)?.status).toBe('archived')
})

it('records a dispatch and keeps an ordinary job eligible to wait', () => {
  const { catalog } = memory()
  const created = catalog.create(daily())
  const key = `schedule:${created.id}:1`
  catalog.recordDispatch(key, { at: NOW, reason: 'prompt' })
  expect(catalog.recentDelivery('sess', NOW - 1_000)).toEqual({ title: 'Standup', prompt: 'Check mail' })
  expect(catalog.list({ sessionKey: 'sess' })[0]?.deliveries).toEqual([{ at: NOW, reason: 'prompt' }])
  expect(catalog.stillWaiting('job:other')).toBe(true)
  catalog.noteSettlement(key, { nextRunAt: null })
  expect(catalog.read(created.id)?.status).toBe('ended')
  expect(catalog.update({ ...daily(), id: created.id, title: 'Again' })).toEqual({
    updated: false,
    code: 'schedule_ended',
  })
})
