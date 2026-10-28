import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { memoryScheduleJobs } from '../../../testkit/index.js'
import { openScheduleCatalog, type ScheduleDb } from '../src/catalog.js'

it('seeks through 100,000 persisted runs across tasks without sorting or scanning completed history', () => {
  const db = new DatabaseSync(':memory:')
  const plans: { sql: string; detail: string }[] = []
  let observe = false
  const explain = (sql: string, params: readonly unknown[] = []) => {
    if (observe && sql.startsWith('SELECT'))
      plans.push({
        sql,
        detail: JSON.stringify(db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...(params as SQLInputValue[]))),
      })
  }
  const sql: ScheduleDb = {
    exec(statement, params) {
      if (params?.length) db.prepare(statement).run(...(params as SQLInputValue[]))
      else db.exec(statement)
    },
    get(statement, params = []) {
      explain(statement, params)
      return db.prepare(statement).get(...(params as SQLInputValue[])) as never
    },
    all(statement, params = []) {
      explain(statement, params)
      return db.prepare(statement).all(...(params as SQLInputValue[])) as never
    },
    transaction(fn) {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  const now = Date.parse('2026-10-27T00:00:00Z')
  const jobs = memoryScheduleJobs()
  try {
    let catalog = openScheduleCatalog(sql, jobs, () => now)
    const task = catalog.create({
      title: 'Scale',
      prompt: 'Report',
      target: { kind: 'session', sessionKey: 'bound' },
      selector: { every_seconds: 60 },
    })
    const key = `schedule:${task.id}:1`
    // An old parked run must remain visible even after many completed rows follow it.
    catalog.recordDispatch(key, { at: now, reason: 'prompt', sessionKey: 'parked' })
    catalog.noteSettlement(key, { nextRunAt: now + 60_000, reason: 'parked' })
    const insert = db.prepare(
      'INSERT INTO schedule_runs (schedule_id, job_key, at, outcome, session_key, ended_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    const receipt = db.prepare(
      "INSERT INTO schedule_run_receipts (run_rowid, id, schedule_id) VALUES (last_insert_rowid(), 'run_' || lower(hex(randomblob(16))), ?)",
    )
    sql.transaction(() => {
      for (let n = 1; n <= 50_000; n++) {
        insert.run(task.id, key, now - n, 'ran', 'past-' + n, now)
        receipt.run(task.id)
      }
    })
    // Reopen the same full history, then mark almost all old results handled.
    catalog = openScheduleCatalog(sql, jobs, () => now)
    db.exec('UPDATE schedule_run_receipts SET is_read = 1 WHERE run_rowid NOT IN (2, 100, 50001)')
    observe = true
    const head = catalog.history({ id: task.id, limit: 20 })
    expect(head.runs).toHaveLength(20)
    if (!head.nextCursor) throw new Error('missing next history page')
    expect(head.runs[0]?.at).toBe(now - 50_000)
    expect(catalog.history({ id: task.id, before: head.nextCursor, limit: 20 }).runs[0]?.at).toBe(
      now - 49_980,
    )
    const deep = db.prepare('SELECT id FROM schedule_run_receipts WHERE run_rowid = 100').get() as {
      id: string
    }
    const tail = catalog.history({ id: task.id, before: deep.id, limit: 100 })
    expect(tail.runs).toHaveLength(99)
    expect(tail.nextCursor).toBeUndefined()
    expect(catalog.history({ resultsOnly: true, unreadOnly: true, limit: 100 }).runs).toHaveLength(3)
    expect(
      catalog.history({ id: task.id, unreadOnly: true, resultsOnly: true, limit: 100 }).runs,
    ).toHaveLength(3)
    expect(catalog.read(task.id)?.runs.some((run) => run.outcome === 'needs_attention')).toBe(true)
    expect(catalog.activity()).toEqual({ nextRunAt: now + 60_000, hasOpenRuns: true })
    expect(catalog.boundSessionKeys()).toEqual(['bound'])
    const other = catalog.create({
      title: 'Other',
      prompt: 'Work',
      target: { kind: 'session', sessionKey: 'other' },
      selector: { every_seconds: 60 },
    })
    sql.transaction(() => {
      for (let n = 1; n <= 50_000; n++) {
        insert.run(other.id, `schedule:${other.id}:1`, now + n, 'ran', 'other', now + n)
        receipt.run(other.id)
      }
    })
    catalog = openScheduleCatalog(sql, jobs, () => now)
    db.exec('ANALYZE')
    const unread = catalog.history({ id: task.id, unreadOnly: true, limit: 1 })
    expect(unread.runs).toHaveLength(1)
    if (!unread.nextCursor) throw new Error('missing unread page')
    expect(catalog.history({ id: task.id, unreadOnly: true, before: unread.nextCursor }).runs).toHaveLength(2)
    const unreadRun = unread.runs[0]
    if (!unreadRun) throw new Error('missing unread run')
    expect(catalog.receipt({ id: task.id, runId: unreadRun.id, read: true })).toEqual({ updated: true })
    expect(catalog.history({ id: task.id, unreadOnly: true }).runs).toHaveLength(2)
    db.prepare("UPDATE schedules SET status = 'ended', next_run_at = NULL WHERE id = ?").run(task.id)
    expect(catalog.list({ search: 'Scale' }).map((row) => row.id)).toEqual([task.id])
    const listPlan = plans.find(
      (p) => p.sql.startsWith('SELECT * FROM schedules') && p.sql.includes('EXISTS'),
    )
    expect(listPlan?.detail).toContain('schedule_runs_open_job')
    const historyPlans = plans.filter((p) => p.sql.startsWith('SELECT r.*, m.id'))
    for (const plan of historyPlans) {
      expect(plan.detail).not.toMatch(/SCAN [rm]\b|USE TEMP B-TREE/)
      expect(plan.detail).toContain(
        plan.sql.includes('r.schedule_id = ?') && plan.sql.includes('m.is_read = 0')
          ? 'schedule_receipts_task_unread'
          : plan.sql.includes('m.is_read = 0')
            ? 'schedule_receipts_unread'
            : 'schedule_runs_task',
      )
    }
    const progress = plans.find((p) => p.sql.startsWith('SELECT rowid AS rid, progress'))
    expect(progress?.detail).toContain('schedule_runs_open_progress')
    const recent = plans.find((p) => p.sql.startsWith('SELECT at, outcome'))
    expect(recent?.detail).toContain('schedule_runs_open_job')
    expect(recent?.detail).toContain('schedule_runs_task')
    const activity = plans.find((p) => p.sql.startsWith('SELECT min(next_run_at)'))
    expect(activity?.detail).toContain('schedules_next_run')
    const open = plans.find((p) => p.sql.startsWith('SELECT 1 FROM schedule_runs'))
    expect(open?.detail).toContain('schedule_runs_open_job')
    expect(db.prepare('SELECT count(*) AS n FROM schedule_runs').get()).toEqual({ n: 100_001 })
  } finally {
    db.close()
  }
})
