import { readFileSync } from 'node:fs'
import { JOBS_DDL, JOBS_INDEXES, openDaemonScheduleDb, openScheduleCatalog } from '@agnes/base/schedule'
import { describe, expect, it } from 'vitest'
import { type JobRow, JobsRepo } from '../src/jobs/repo.js'
import { sqliteTables } from './sqlite-tables.js'

const row = (key: string, over: Partial<JobRow> = {}): JobRow => ({
  idempotencyKey: key,
  sessionKey: 'k',
  profileHash: 'h',
  payload: { prompt: 'daily report' },
  schedule: { kind: 'once' },
  status: 'waiting',
  attempts: 0,
  maxAttempts: 3,
  backoffMs: 1_000,
  delayUntil: 0,
  stalledCounter: 0,
  protected: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('JobsRepo', () => {
  it('creates jobs from the one shared schedule DDL', () => {
    expect(JOBS_DDL).toMatch(/^CREATE TABLE IF NOT EXISTS jobs \(/)
    expect(JOBS_INDEXES).toHaveLength(2)
    expect(readFileSync(new URL('../src/jobs/repo.ts', import.meta.url), 'utf8')).not.toContain(
      'CREATE TABLE IF NOT EXISTS jobs',
    )
    const t = sqliteTables().table('jobs')
    new JobsRepo(t, () => 0)
    expect(
      t
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE tbl_name = 'jobs' ORDER BY name")
        .map((r) => r.name),
    ).toEqual(['jobs', 'jobs_due', 'jobs_session', 'sqlite_autoindex_jobs_1'])
  })

  it('inserts idempotently, claims due rows, heartbeats, settles, reclaims, and cancels', () => {
    let now = 1_000
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => now)
    expect(repo.insert(row('j1'))).toBe(true)
    expect(repo.insert(row('j1'))).toBe(false)
    repo.insert(row('j2', { delayUntil: 5_000 }))

    const claimed = repo.claimDue(now, 'agnesd-1', 60_000, 10)
    expect(claimed.map((job) => job.idempotencyKey)).toEqual(['j1'])
    expect(repo.get('j1')).toMatchObject({
      status: 'active',
      leaseOwner: 'agnesd-1',
      leaseUntil: 61_000,
    })
    expect(repo.claimDue(now, 'agnesd-2', 60_000, 10)).toEqual([])

    repo.heartbeat('j1', 'agnesd-1', 2_000)
    expect(repo.get('j1')).toMatchObject({ heartbeat: 2_000, leaseUntil: 62_000 })
    repo.heartbeat('j1', 'wrong-owner', 3_000)
    expect(repo.get('j1')).toMatchObject({ heartbeat: 2_000, leaseUntil: 62_000 })

    now = 70_000
    expect(repo.reclaimStalled(now, 5)).toEqual({ requeued: ['j1'], dead: [] })
    expect(repo.get('j1')).toMatchObject({ status: 'waiting', stalledCounter: 1, attempts: 0 })

    repo.settle('j1', { status: 'completed', result: { seq: 9 } })
    expect(repo.cancel('j1')).toBe('terminal')
    expect(repo.cancel('j2')).toBe('cancelled')
    expect(repo.cancel('missing')).toBe('not-found')
    expect(repo.countWaiting('k')).toBe(0)
  })

  it('promotes delayed rows and marks repeatedly stalled work dead', () => {
    let now = 0
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => now)
    repo.insert(row('delayed', { status: 'delayed', delayUntil: 10 }))
    expect(repo.promoteDelayed(9)).toBe(0)
    expect(repo.promoteDelayed(10)).toBe(1)
    expect(repo.get('delayed')?.status).toBe('waiting')

    repo.insert(row('stalled', { stalledCounter: 5 }))
    repo.claimDue(now, 'o', 10, 10)
    now = 100
    expect(repo.reclaimStalled(now, 5)).toEqual({ requeued: [], dead: ['stalled'] })
    expect(repo.get('stalled')).toMatchObject({ status: 'dead', error: 'stalled', stalledCounter: 6 })
  })

  it('does not overwrite terminal rows during a stale settle', () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 20)
    repo.insert(row('j'))
    expect(repo.cancel('j')).toBe('cancelled')
    repo.settle('j', { status: 'completed', result: { seq: 1 } })
    expect(repo.get('j')?.status).toBe('cancelled')
    expect(repo.get('j')?.result).toBeUndefined()
  })

  it('backs the schedule catalog: queued through insert checks, on the catalog connection', async () => {
    const tables = sqliteTables()
    const repo = new JobsRepo(tables.table('jobs'), () => 0)
    const catalog = openScheduleCatalog(
      openDaemonScheduleDb(tables.table('schedules')),
      repo.scheduleJobs(),
      () => 1_000,
    )
    const created = catalog.create({
      target: { kind: 'session', sessionKey: 's' },
      title: 'T',
      prompt: 'P',
      selector: { daily: { time: '09:00', timeZone: 'UTC' } },
    })
    const key = `schedule:${created.id}:1`
    expect(repo.get(key)).toMatchObject({
      status: 'waiting',
      sessionKey: 's',
      profileHash: 'schedule',
      payload: { prompt: 'P' },
      maxAttempts: 3,
    })
    expect(() =>
      repo.scheduleJobs().add({
        key,
        sessionKey: 'other',
        prompt: 'P',
        schedule: { kind: 'once' },
        delayUntil: 0,
        now: 1_000,
      }),
    ).toThrow(expect.objectContaining({ data: expect.objectContaining({ reason: 'JOB_IDENTITY_CONFLICT' }) }))
    catalog.control(created.id, 'pause')
    expect(repo.get(key)?.status).toBe('cancelled')
    const table = tables.table('schedules')
    table.exec(`CREATE TRIGGER fail_resume BEFORE UPDATE OF status ON schedules
      WHEN OLD.status = 'paused' AND NEW.status = 'active'
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
    expect(() => catalog.control(created.id, 'resume')).toThrow('simulated write failure')
    expect(catalog.read(created.id)).toMatchObject({ status: 'paused', revision: 1 })
    expect(repo.get(`schedule:${created.id}:2`)).toBeUndefined()
    table.exec('DROP TRIGGER fail_resume')
    expect(catalog.control(created.id, 'resume')).toMatchObject({ status: 'active', revision: 2 })
    expect(repo.get(`schedule:${created.id}:2`)).toMatchObject({ status: 'waiting', sessionKey: 's' })
    await tables.close()
  })
})
