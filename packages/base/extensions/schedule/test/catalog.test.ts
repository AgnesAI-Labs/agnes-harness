import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { memoryScheduleJobs } from '../../../testkit/index.js'
import {
  createSchedulesPort,
  openScheduleCatalog,
  type ScheduleDb,
  ScheduleRejected,
  type ScheduleView,
} from '../src/catalog.js'

const NOW = Date.parse('2026-09-07T00:00:00Z')

type Jobs = ReturnType<typeof memoryScheduleJobs>

function sqlOf(db: DatabaseSync): ScheduleDb {
  return {
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
}

function memory(now = NOW) {
  const db = new DatabaseSync(':memory:')
  const jobs = memoryScheduleJobs()
  return { db, jobs, catalog: openScheduleCatalog(sqlOf(db), jobs, () => now) }
}

function openScheduleCatalogAt(db: DatabaseSync, jobs: Jobs, clock: () => number) {
  return openScheduleCatalog(sqlOf(db), jobs, clock)
}

function daily(sessionKey = 'sess') {
  return {
    target: { kind: 'session', sessionKey },
    title: 'Standup',
    prompt: 'Check mail',
    selector: { daily: { time: '09:00', timeZone: 'UTC' } },
  }
}

function job(jobs: Jobs, id: string) {
  return [...jobs.rows].find(([key]) => key.startsWith(`schedule:${id}:`))?.[1]
}

function activate(jobs: Jobs, prefix: string) {
  for (const [key, row] of jobs.rows) if (key.startsWith(prefix)) row.status = 'active'
}

it('has no jobs SQL in the catalog', () => {
  expect(readFileSync(new URL('../src/catalog.ts', import.meta.url), 'utf8')).not.toMatch(
    /(INSERT INTO|UPDATE|FROM) jobs\b/,
  )
})

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
  const { jobs, catalog } = memory()
  const created = catalog.create(daily())
  activate(jobs, `schedule:${created.id}:`)
  expect(catalog.update({ ...daily(), id: created.id, prompt: 'Other' })).toEqual({
    updated: false,
    code: 'schedule_conflict',
  })
  const titled = catalog.update({ ...daily(), id: created.id, title: 'Later' }) as ScheduleView
  expect(titled.title).toBe('Later')
  expect(titled.prompt).toBe('Check mail')
  expect(job(jobs, created.id)?.status).toBe('active')
})

it('cancels a waiting job on archive and leaves an in-flight job running', () => {
  const waiting = memory()
  const queued = waiting.catalog.create(daily())
  expect(waiting.catalog.archive(queued.id)).toEqual({ deleted: true })
  expect(job(waiting.jobs, queued.id)?.status).toBe('cancelled')
  expect(waiting.catalog.stillWaiting(`schedule:${queued.id}:1`)).toBe(false)
  expect(waiting.catalog.archive(queued.id)).toEqual({ deleted: false })

  const live = memory()
  const running = live.catalog.create(daily())
  activate(live.jobs, `schedule:${running.id}:`)
  expect(live.catalog.archive(running.id)).toEqual({ deleted: true })
  expect(job(live.jobs, running.id)?.status).toBe('active')
  expect(live.catalog.stillWaiting(`schedule:${running.id}:1`)).toBe(false)
  live.catalog.noteSettlement(`schedule:${running.id}:1`, { nextRunAt: NOW + 86_400_000 })
  expect(live.catalog.read(running.id)?.status).toBe('archived')
})

it('records a dispatch and keeps an ordinary job eligible to wait', () => {
  const { catalog } = memory()
  const created = catalog.create(daily())
  const key = `schedule:${created.id}:1`
  catalog.recordDispatch(key, { at: NOW, reason: 'prompt', sessionKey: 'sess' })
  expect(catalog.recentDelivery('sess', NOW - 1_000)).toEqual({ title: 'Standup', prompt: 'Check mail' })
  // An idle session started a turn: a run in progress, not a failed delivery.
  expect(catalog.list({ sessionKey: 'sess' })[0]?.runs).toEqual([
    { at: NOW, outcome: 'running', sessionKey: 'sess' },
  ])
  expect(catalog.stillWaiting('job:other')).toBe(true)
  catalog.noteSettlement(key, { nextRunAt: null })
  expect(catalog.read(created.id)?.status).toBe('ended')
  expect(catalog.update({ ...daily(), id: created.id, title: 'Again' })).toEqual({
    updated: false,
    code: 'schedule_ended',
  })
})

const fresh = (extra: Record<string, unknown> = {}) => ({
  title: 'Daily report',
  prompt: 'Write the report',
  selector: { daily: { time: '09:00', timeZone: 'UTC' } },
  target: { kind: 'new-session', cwd: '/work/report', ...extra },
})

it('keeps the target on the schedule row and run progress on the run row', () => {
  const { db, catalog } = memory()
  const created = catalog.create({ ...fresh(), origin: 'sess' })
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schedule_targets', 'schedule_run_progress')",
      )
      .all(),
  ).toEqual([])
  const row = db.prepare('SELECT target, origin FROM schedules WHERE id = ?').get(created.id) as {
    target: string
    origin: string | null
  }
  expect(JSON.parse(row.target)).toEqual(created.target)
  expect(row.origin).toBe('sess')
  catalog.recordDispatch(`schedule:${created.id}:1`, { at: NOW, reason: 'prompt', sessionKey: 'run-1' })
  const run = db.prepare('SELECT progress FROM schedule_runs WHERE schedule_id = ?').get(created.id) as {
    progress: string
  }
  expect(JSON.parse(run.progress)).toEqual({ outcome: 'running', needsAttention: false, pending: {} })
})

it('validates a target shape and stores a new-session target with a placeholder job session', () => {
  const { jobs, catalog } = memory()
  const created = catalog.create({
    ...fresh({
      loop: { id: 'data-report', version: '1.0.0' },
      bundles: ['@agnes-fde/data-report#bundle'],
      preset: 'review',
      model: { route: 'agnes', model: 'agnes-1' },
    }),
    origin: 'sess',
  })
  expect(created.target).toEqual({
    kind: 'new-session',
    cwd: '/work/report',
    loop: { id: 'data-report', version: '1.0.0' },
    bundles: ['@agnes-fde/data-report#bundle'],
    preset: 'review',
    model: { route: 'agnes', model: 'agnes-1' },
  })
  expect(created.origin).toBe('sess')
  // The session that created it lists it; the job waits on a placeholder the daemon replaces per run.
  expect(catalog.list({ sessionKey: 'sess' }).map((row) => row.id)).toEqual([created.id])
  expect(jobs.rows.get(`schedule:${created.id}:1`)?.sessionKey).toBe(`schedule:${created.id}`)
  expect(catalog.targetOf(`schedule:${created.id}:1`)).toMatchObject({
    id: created.id,
    title: 'Daily report',
  })

  for (const bad of [
    undefined,
    { kind: 'elsewhere' },
    { kind: 'session' },
    { kind: 'session', sessionKey: 's', cwd: '/w' },
    { kind: 'new-session' },
    { kind: 'new-session', cwd: '/w', bundles: ['a', 'a'] },
    { kind: 'new-session', cwd: '/w', loop: { id: 'x' } },
    { kind: 'new-session', cwd: '/w', model: { route: 'r' } },
    { kind: 'new-session', cwd: 'bad\nline' },
  ])
    expect(() => catalog.create({ ...fresh(), target: bad })).toThrowError(
      expect.objectContaining({ code: 'invalid_target' }),
    )
})

it('reads a schedule row with no stored target as its session target', () => {
  const { db, catalog } = memory()
  db.prepare(
    `INSERT INTO schedules (id, session_key, title, prompt, selector, status, job_key, revision, next_run_at, created_at, updated_at)
     VALUES ('sched_00000000000000aa', 'old-session', 'Old', 'Ping', '{"every_seconds":3600}', 'active', NULL, 1, NULL, 0, 0)`,
  ).run()
  expect(catalog.read('sched_00000000000000aa')).toMatchObject({
    target: { kind: 'session', sessionKey: 'old-session' },
    origin: 'old-session',
    runs: [],
  })
})

it('moves a task between targets and back, issuing a new job each time', () => {
  const { jobs, catalog } = memory()
  const created = catalog.create(daily())
  const moved = catalog.update({ ...fresh(), id: created.id, owner: 'sess' }) as ScheduleView
  expect(moved).toMatchObject({ target: { kind: 'new-session', cwd: '/work/report' }, revision: 2 })
  expect(catalog.list({ sessionKey: 'sess' }).map((row) => row.id)).toEqual([created.id])
  expect(jobs.rows.get(`schedule:${created.id}:1`)?.status).toBe('cancelled')
  // Another session cannot change it.
  expect(catalog.update({ ...daily(), id: created.id, owner: 'other' })).toEqual({
    updated: false,
    code: 'schedule_not_found',
  })
  const back = catalog.update({ ...daily(), id: created.id, owner: 'sess' }) as ScheduleView
  expect(back.target).toEqual({ kind: 'session', sessionKey: 'sess' })
})

it('records run outcomes: started then ran, joined a running turn, and failed with a reason', () => {
  let now = NOW
  const base = memory()
  const catalog = openScheduleCatalogAt(base.db, base.jobs, () => now)
  const created = catalog.create({ ...fresh(), origin: 'sess' })
  const key = `schedule:${created.id}:1`
  catalog.recordDispatch(key, { at: now, reason: 'prompt', sessionKey: 'run-1' })
  now += 42_000
  catalog.noteSettlement(key, { nextRunAt: now + 86_400_000, at: now })
  catalog.recordDispatch(key, { at: now, seq: 9, sessionKey: 'run-2' })
  catalog.recordFailure(key, { at: now + 1, reason: 'workspace_missing' })
  catalog.recordDispatch(key, { at: now + 2, reason: 'prompt', sessionKey: 'run-3' })
  catalog.recordFailure(key, {
    at: now + 5,
    reason: 'turn_error',
    detail: 'x'.repeat(900),
    sessionKey: 'run-3',
  })
  const runs = catalog.read(created.id)?.runs ?? []
  expect(runs.map((run) => run.outcome)).toEqual(['ran', 'delivered', 'failed', 'failed'])
  expect(runs[0]).toEqual({ at: NOW, outcome: 'ran', sessionKey: 'run-1', endedAt: NOW + 42_000 })
  expect(runs[1]).toMatchObject({ sessionKey: 'run-2', seq: 9 })
  expect(runs[2]).toMatchObject({ reason: 'workspace_missing', endedAt: now + 1 })
  expect(runs[3]).toMatchObject({ reason: 'turn_error', sessionKey: 'run-3', endedAt: now + 5 })
  expect(runs[3]?.detail).toHaveLength(500)
  expect(catalog.recentDelivery('run-1', NOW)).toEqual({ title: 'Daily report', prompt: 'Write the report' })
})

it('pauses, resumes and runs a task now', () => {
  const { jobs, catalog } = memory()
  const created = catalog.create(daily())
  expect(catalog.control(created.id, 'resume')).toMatchObject({ status: 'active' })
  const paused = catalog.control(created.id, 'pause') as ScheduleView
  expect(paused).toMatchObject({ status: 'paused', nextRunAt: null })
  expect(job(jobs, created.id)?.status).toBe('cancelled')
  expect(catalog.control(created.id, 'run')).toEqual({ updated: false, code: 'schedule_paused' })
  expect(catalog.stillWaiting(`schedule:${created.id}:1`)).toBe(false)
  // A paused task stays listed and editable.
  expect(catalog.list({ sessionKey: 'sess' })).toHaveLength(1)
  expect(catalog.update({ ...daily(), id: created.id, title: 'Renamed' })).toMatchObject({
    status: 'paused',
    title: 'Renamed',
  })
  const resumed = catalog.control(created.id, 'resume') as ScheduleView
  expect(resumed).toMatchObject({
    status: 'active',
    revision: 2,
    nextRunAt: Date.parse('2026-09-07T09:00:00Z'),
  })
  const now = catalog.control(created.id, 'run') as ScheduleView
  expect(now.nextRunAt).toBe(NOW)
  const queued = jobs.rows.get(`schedule:${created.id}:2`)
  expect({ status: queued?.status, delayUntil: queued?.delayUntil }).toEqual({
    status: 'waiting',
    delayUntil: NOW,
  })
  activate(jobs, `schedule:${created.id}:2`)
  expect(catalog.control(created.id, 'run')).toEqual({ updated: false, code: 'schedule_running' })
  expect(catalog.control('sched_ffffffffffffffff', 'run')).toEqual({
    updated: false,
    code: 'schedule_not_found',
  })
  expect(catalog.archive(created.id)).toEqual({ deleted: true })
  expect(catalog.control(created.id, 'resume')).toEqual({ updated: false, code: 'schedule_ended' })
})

it('refuses to resume a one-time task whose moment has passed', () => {
  let now = NOW
  const base = memory()
  const catalog = openScheduleCatalogAt(base.db, base.jobs, () => now)
  const created = catalog.create({ ...daily(), selector: { at: '2026-09-07T01:00:00Z' } })
  catalog.control(created.id, 'pause')
  now = Date.parse('2026-09-08T00:00:00Z')
  expect(catalog.control(created.id, 'resume')).toEqual({ updated: false, code: 'not_future' })
})

it('checks a new-session target through the port before saving it', async () => {
  const base = memory()
  const checked: unknown[] = []
  const port = createSchedulesPort(
    sqlOf(base.db),
    base.jobs,
    () => NOW,
    async (target) => {
      checked.push(target)
      return target.cwd === '/gone' ? 'workspace_missing' : undefined
    },
  )
  await expect(
    port.upsert({ ...fresh(), target: { kind: 'new-session', cwd: '/gone' } }),
  ).rejects.toThrowError(expect.objectContaining({ code: 'workspace_missing' }))
  const created = (await port.upsert(fresh())) as ScheduleView
  expect(created.target).toMatchObject({ kind: 'new-session' })
  // A session target is not a workspace question.
  await port.upsert({ ...daily(), id: created.id })
  expect(checked).toHaveLength(2)
  expect(await port.read(created.id)).toEqual({
    target: { kind: 'session', sessionKey: 'sess' },
    sessionKey: 'sess',
  })
})

it.each(['approve', 'reply', 'expire', 'refuse'] as const)(
  'tracks a parked run through %s without reporting it ran',
  (action) => {
    let now = NOW
    const { db, jobs } = memory()
    let catalog = openScheduleCatalogAt(db, jobs, () => now)
    const created = catalog.create({
      ...daily(),
      target: {
        kind: 'session',
        sessionKey: 'sess',
        unattendedApproval: action === 'refuse' ? 'refuse' : 'notify',
      },
    })
    const key = `schedule:${created.id}:1`
    catalog.recordDispatch(key, { at: now, reason: 'prompt', sessionKey: 'sess', seq: 10 })
    let seq = 10
    const event = (type: string, data: unknown) =>
      ({ type, data, seq: ++seq, ts: new Date(now).toISOString() }) as import('@agnes/protocol').EventEnvelope
    // A cold worker replays the session's earlier turns before this schedule's dispatch.
    for (const row of [
      { ...event('turn/start', { turn: 1, trigger: 'prompt' }), seq: 1 },
      { ...event('turn/end', { reason: 'completed', lastAssistantSeq: null }), seq: 9 },
    ])
      catalog.observeSession('sess', row)
    expect(catalog.read(created.id)?.runs[0]?.outcome).toBe('running')
    catalog.observeSession('sess', event('turn/start', { turn: 1, trigger: 'prompt' }))
    const pending = {
      handle: { id: 'd1', sessionId: 'sess' },
      request: { expiresAt: new Date(now + 1000).toISOString() },
      result: null,
      invalidation: null,
      consumption: null,
    }
    const requested = event('decision/state', pending)
    if (action !== 'reply') catalog.observeSession('sess', requested)
    expect(catalog.observeSession('sess', event('turn/end', { reason: 'parked' }))).toBe(true)
    catalog.noteSettlement(key, { at: now, nextRunAt: now + 60_000, reason: 'parked' })
    expect(catalog.read(created.id)?.runs[0]).toMatchObject({
      outcome: action === 'reply' ? 'needs_attention' : 'waiting_approval',
      reason: 'needs_attention',
    })
    expect(catalog.read(created.id)?.runs[0]?.endedAt).toBeUndefined()
    expect(catalog.hasWaiting(key)).toBe(true)
    catalog.recordFailure(key, { at: now + 1, reason: 'approval_pending_previous_run', sessionKey: 'sess' })
    expect(catalog.read(created.id)?.runs.map((run) => run.outcome)).toEqual([
      action === 'reply' ? 'needs_attention' : 'waiting_approval',
      'failed',
    ])
    // Reopening the catalog retains both the pending deadline and the recurring schedule.
    catalog = openScheduleCatalogAt(db, jobs, () => now)
    if (action === 'approve') {
      // Saying "received" in another turn is not an approval of the parked operation.
      catalog.observeSession('sess', event('turn/start', { turn: 2, trigger: 'prompt' }))
      catalog.observeSession('sess', event('turn/end', { reason: 'completed', lastAssistantSeq: null }))
      expect(catalog.read(created.id)?.runs[0]?.outcome).toBe('waiting_approval')
      catalog.observeSession(
        'sess',
        event('decision/state', {
          ...pending,
          result: { reason: 'answered', response: { option: 'allowed-once' } },
        }),
      )
      const resumed = event('turn/start', { turn: 3, trigger: 'approval-resume' })
      catalog.observeSession('sess', resumed)
      // Another question after a human continuation must request another notification.
      const second = { ...pending, handle: { id: 'd2', sessionId: 'sess' } }
      catalog.observeSession('sess', event('decision/state', second))
      expect(catalog.observeSession('sess', event('turn/end', { reason: 'parked' }))).toBe(true)
      catalog.observeSession(
        'sess',
        event('decision/state', {
          ...second,
          result: { reason: 'answered', response: { option: 'allowed-once' } },
        }),
      )
      catalog.observeSession('sess', event('turn/start', { turn: 4, trigger: 'approval-resume' }))
      const finished = event('turn/end', { reason: 'completed', lastAssistantSeq: null })
      catalog.observeSession('sess', finished)
      expect(catalog.read(created.id)?.runs[0]).toMatchObject({ outcome: 'ran', endedAt: now })
      expect(catalog.hasWaiting(key)).toBe(false)
      catalog = openScheduleCatalogAt(db, jobs, () => now)
      // Reopening and replaying old pending/continuation rows cannot resurrect a completed run.
      for (const row of [requested, resumed, finished]) catalog.observeSession('sess', row)
      expect(catalog.read(created.id)?.runs[0]?.outcome).toBe('ran')
      expect(catalog.hasWaiting(key)).toBe(false)
    } else if (action === 'reply') {
      // A reminder without a pending permission decision can continue with ordinary user input.
      catalog.observeSession('sess', event('turn/start', { turn: 2, trigger: 'prompt' }))
      catalog.observeSession('sess', event('turn/end', { reason: 'completed', lastAssistantSeq: null }))
      expect(catalog.read(created.id)?.runs[0]).toMatchObject({ outcome: 'ran', endedAt: now })
      catalog = openScheduleCatalogAt(db, jobs, () => now)
      expect(catalog.hasWaiting(key)).toBe(false)
      expect(catalog.read(created.id)?.runs[0]?.outcome).toBe('ran')
    } else if (action === 'expire') {
      now += 1000
      expect(catalog.read(created.id)?.runs[0]).toMatchObject({
        outcome: 'failed',
        reason: 'approval_expired',
        endedAt: now,
      })
    } else {
      catalog.observeSession('sess', event('x/core/unattended-refused', {}))
      expect(catalog.read(created.id)?.runs[0]).toMatchObject({
        outcome: 'failed',
        reason: 'approval_refused',
      })
    }
    expect(catalog.hasWaiting(key)).toBe(false)
    expect(catalog.read(created.id)).toMatchObject({ status: 'active', nextRunAt: NOW + 60_000 })
    if (action === 'expire') {
      catalog.recordDispatch(key, { at: ++now, reason: 'prompt', sessionKey: 'after-expiry' })
      catalog.observeSession('after-expiry', event('turn/start', { turn: 3, trigger: 'prompt' }))
      catalog.observeSession('after-expiry', event('turn/end', { reason: 'completed' }))
      expect(catalog.read(created.id)?.runs.at(-1)).toMatchObject({
        outcome: 'ran',
        needsAttention: true,
        reason: 'previous_approval_expired',
      })
      catalog.recordDispatch(key, { at: ++now, reason: 'prompt', sessionKey: 'pending-again' })
      catalog.noteSettlement(key, { at: now, nextRunAt: now + 60_000, reason: 'parked' })
      for (let i = 0; i < 55; i++)
        catalog.recordFailure(key, { at: ++now, reason: 'approval_pending_previous_run' })
      expect(catalog.hasWaiting(key)).toBe(true)
      expect(
        catalog
          .read(created.id)
          ?.runs.some((run) => run.sessionKey === 'pending-again' && run.needsAttention),
      ).toBe(true)
    }
    db.close()
  },
)

it('finds the open run of a job through the schedule_runs_schedule index', () => {
  const db = new DatabaseSync(':memory:')
  const seen: Array<{ sql: string; params: readonly unknown[] }> = []
  const base = sqlOf(db)
  const catalog = openScheduleCatalog(
    {
      ...base,
      get: <T>(sql: string, params?: readonly unknown[]) => {
        seen.push({ sql, params: params ?? [] })
        return base.get<T>(sql, params)
      },
    },
    memoryScheduleJobs(),
    () => NOW,
  )
  const created = catalog.create(daily())
  catalog.recordDispatch(`schedule:${created.id}:1`, { at: NOW, reason: 'prompt', sessionKey: 'run-1' })
  const open = seen.find((q) => /FROM schedule_runs WHERE[\s\S]*job_key = \?/.test(q.sql))
  if (!open) throw new Error('openRun query was not issued')
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${open.sql}`)
    .all(...(open.params as SQLInputValue[])) as Array<{
    detail: string
  }>
  expect(plan.map((row) => row.detail).join('\n')).toContain('USING INDEX schedule_runs_schedule')
})
