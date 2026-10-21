import { readFileSync } from 'node:fs'
import { JOBS_DDL, JOBS_INDEXES } from '@agnes/base/schedule'
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
})
