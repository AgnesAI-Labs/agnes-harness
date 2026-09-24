import { describe, expect, it, vi } from 'vitest'
import { JobsRepo } from '../src/jobs/repo.js'
import { JobsService } from '../src/jobs/service.js'
import { sqliteTables } from './sqlite-tables.js'

describe('JobsService', () => {
  it('enqueues idempotently, polls, and cancels', async () => {
    const now = 1_000_000
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => now)
    const onCancel = vi.fn()
    const service = new JobsService({ repo, profileHash: 'h', clock: () => now, onCancel })
    const spec = {
      idempotencyKey: 'daily',
      sessionKey: 'agnes:local:agent:cli:dm:user',
      payload: { prompt: 'report' },
      schedule: { kind: 'cron', expr: '0 9 * * *' },
    } as const

    expect(await service.enqueue(spec, { local: false })).toEqual({ jobId: 'daily' })
    expect(await service.enqueue(spec, { local: false })).toEqual({ jobId: 'daily' })
    expect(await service.poll('daily')).toMatchObject({
      jobId: 'daily',
      status: 'waiting',
      attempts: 0,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    })

    await service.cancel('daily')
    expect((await service.poll('daily')).status).toBe('cancelled')
    expect(onCancel).not.toHaveBeenCalled()
    await service.cancel('daily')
  })

  it('gates explicitly and implicitly protected jobs to local callers', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 0)
    const service = new JobsService({
      repo,
      profileHash: 'h',
      clock: () => 0,
      protectedNames: (spec) => 'command' in spec.payload,
    })
    const base = {
      sessionKey: 'agnes:local:agent:cli:dm:user',
      payload: { prompt: 'report' },
      schedule: { kind: 'once' },
    } as const

    await expect(
      service.enqueue({ ...base, idempotencyKey: 'explicit', protected: true }, { local: false }),
    ).rejects.toMatchObject({ code: -32006 })
    await expect(
      service.enqueue(
        {
          ...base,
          idempotencyKey: 'implicit',
          payload: { command: { method: 'resume', params: {} } },
        },
        { local: false },
      ),
    ).rejects.toMatchObject({ code: -32006 })
    await expect(
      service.enqueue({ ...base, idempotencyKey: 'explicit', protected: true }, { local: true }),
    ).resolves.toEqual({ jobId: 'explicit' })
  })

  it('rejects invalid specs and impossible cron schedules with RPC errors', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 0)
    const service = new JobsService({ repo, profileHash: 'h', clock: () => 0 })
    await expect(service.enqueue({ idempotencyKey: 'bad' }, { local: true })).rejects.toMatchObject({
      code: -32602,
    })
    await expect(
      service.enqueue(
        {
          idempotencyKey: 'never',
          sessionKey: 'k',
          payload: { prompt: 'x' },
          schedule: { kind: 'cron', expr: '0 0 30 2 *' },
        },
        { local: true },
      ),
    ).rejects.toMatchObject({ code: -32011 })
    await expect(service.poll('missing')).rejects.toMatchObject({ code: -32003 })
    await expect(service.cancel('missing')).rejects.toMatchObject({ code: -32003 })
  })

  it('aborts a cancelled active job', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 0)
    const onCancel = vi.fn()
    const service = new JobsService({ repo, profileHash: 'h', clock: () => 0, onCancel })
    await service.enqueue(
      {
        idempotencyKey: 'active',
        sessionKey: 'k',
        payload: { prompt: 'x' },
        schedule: { kind: 'once' },
      },
      { local: true },
    )
    repo.claimDue(0, 'owner', 60_000, 1)
    await service.cancel('active')
    expect(onCancel).toHaveBeenCalledWith('active')
  })
})
