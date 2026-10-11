import { checkToolDef, type JobInfo, type JobOutput, type ToolContext } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { jobTool } from '../src/tools/job.js'

const textOf = (r: { content: { type: string }[] }): string =>
  (r.content[0] as { type: 'text'; text: string }).text

const running: JobInfo = {
  id: 'job-1',
  command: 'uvicorn app:app',
  cwd: '/work/proj',
  status: 'running',
  startedAt: '2026-10-11T00:00:00.000Z',
}

function jobsWith(overrides: Partial<NonNullable<ToolContext['jobs']>> = {}) {
  const outputs: unknown[] = []
  const jobs: NonNullable<ToolContext['jobs']> = {
    start: async () => ({ ...running }),
    output: async (id, opts): Promise<JobOutput> => {
      outputs.push([id, opts])
      return { ...running, text: 'INFO started\n', next: 12, dropped: 0 }
    },
    stop: async () => ({ ...running, status: 'stopped' }),
    list: async () => [
      { ...running },
      { ...running, id: 'job-2', command: 'npm test', status: 'exited', code: 1 },
    ],
    ...overrides,
  }
  return { jobs, outputs }
}

describe('job', () => {
  it('has a complete definition that names no platform', () => {
    expect(checkToolDef(jobTool)).toEqual({ ok: true })
    expect(jobTool.meta).toMatchObject({ replay: 'never', requiresApproval: 'never', isDestructive: false })
    expect(jobTool.description).not.toMatch(/bash|powershell|windows|posix/i)
  })

  it('lists the jobs with their state', async () => {
    const r = await jobTool.execute({ action: 'list' }, fakeToolContext({ jobs: jobsWith().jobs }))
    expect(textOf(r)).toBe('[job-1 running] uvicorn app:app\n[job-2 exited 1] npm test')
  })

  it('says so when there are none', async () => {
    const r = await jobTool.execute(
      { action: 'list' },
      fakeToolContext({ jobs: jobsWith({ list: async () => [] }).jobs }),
    )
    expect(textOf(r)).toBe('no background jobs in this session')
  })

  it('returns the new output with the state last', async () => {
    const { jobs, outputs } = jobsWith()
    const r = await jobTool.execute({ action: 'output', id: 'job-1' }, fakeToolContext({ jobs }))
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe('INFO started\n[job-1 running]')
    expect(outputs).toEqual([['job-1', {}]])
  })

  it('says how much output was no longer kept, and when there is nothing new', async () => {
    const { jobs } = jobsWith({
      output: async () => ({ ...running, status: 'exited', code: 0, text: '', next: 900, dropped: 300 }),
    })
    const r = await jobTool.execute({ action: 'output', id: 'job-1' }, fakeToolContext({ jobs }))
    expect(textOf(r)).toBe('[300 earlier characters were not kept]\n[no new output]\n[job-1 exited 0]')
  })

  it('holds a wait inside the call, with a second left to answer in', async () => {
    const { jobs, outputs } = jobsWith()
    await jobTool.execute(
      { action: 'output', id: 'job-1', waitMs: 600_000 },
      fakeToolContext({ jobs, timeoutMs: 30_000 }),
    )
    await jobTool.execute(
      { action: 'output', id: 'job-1', waitMs: 5000 },
      fakeToolContext({ jobs, timeoutMs: 30_000 }),
    )
    expect(outputs).toEqual([
      ['job-1', { waitMs: 29_000 }],
      ['job-1', { waitMs: 5000 }],
    ])
  })

  it('stops a job and says what it was', async () => {
    const r = await jobTool.execute(
      { action: 'stop', id: 'job-1' },
      fakeToolContext({ jobs: jobsWith().jobs }),
    )
    expect(textOf(r)).toBe('[job-1 stopped] uvicorn app:app')
  })

  it('asks for the id that output and stop need', async () => {
    for (const action of ['output', 'stop'] as const) {
      const r = await jobTool.execute({ action }, fakeToolContext({ jobs: jobsWith().jobs }))
      expect(r.isError).toBe(true)
      expect(textOf(r)).toBe(`action ${action} needs the id of a job`)
    }
  })

  it('reports an unknown job as a failed call rather than throwing', async () => {
    const { jobs } = jobsWith({
      stop: () => Promise.reject(new Error('E_JOB_UNKNOWN: no background job "job-9" in this session')),
    })
    const r = await jobTool.execute({ action: 'stop', id: 'job-9' }, fakeToolContext({ jobs }))
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('E_JOB_UNKNOWN')
  })

  it('is unavailable where the session keeps no jobs', async () => {
    const r = await jobTool.execute({ action: 'list' }, fakeToolContext())
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('background jobs are unavailable here')
  })
})
