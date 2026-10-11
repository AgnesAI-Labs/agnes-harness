import { afterEach, describe, expect, it, vi } from 'vitest'
import { JOB_OUTPUT_KEEP, JobRegistry, MAX_RUNNING_JOBS } from '../src/effects/jobs.js'
import type { SandboxProcess } from '../src/effects/seams.js'

/** A process the test drives: it prints when told to, and exits when told to or when stopped. */
function fakeProcess() {
  let listener: ((text: string) => void) | undefined
  let exit!: (status: { code: number | null; signal?: string }) => void
  const done = new Promise<{ code: number | null; signal?: string }>((resolve) => {
    exit = resolve
  })
  const stop = vi.fn(async () => {
    exit({ code: null, signal: 'SIGTERM' })
  })
  const process: SandboxProcess = {
    pid: 42,
    onOutput: (next) => {
      listener = next
    },
    done,
    stop,
  }
  return { process, print: (text: string) => listener?.(text), exit, stop }
}

function sandboxOf(...processes: ReturnType<typeof fakeProcess>[]) {
  const starts: unknown[][] = []
  return {
    starts,
    sandbox: {
      start: async (cmd: string[], opts: { cwd: string; env?: Record<string, string> }) => {
        starts.push([cmd, opts])
        const next = processes.shift()
        if (!next) throw new Error('no more processes')
        return next.process
      },
    },
  }
}

const clock = () => new Date('2026-10-11T00:00:00.000Z')
const start = (registry: JobRegistry, sandbox: ReturnType<typeof sandboxOf>['sandbox'], command = 'serve') =>
  registry.start(sandbox, ['$SHELL', command], { cwd: '/work', command, env: { PYTHONUNBUFFERED: '1' } })

afterEach(() => vi.useRealTimers())

describe('JobRegistry', () => {
  it('numbers jobs, starts them through the sandbox and reports them running', async () => {
    const { sandbox, starts } = sandboxOf(fakeProcess(), fakeProcess())
    const registry = new JobRegistry(clock)
    expect(await start(registry, sandbox)).toEqual({
      id: 'job-1',
      command: 'serve',
      cwd: '/work',
      status: 'running',
      startedAt: '2026-10-11T00:00:00.000Z',
    })
    expect((await start(registry, sandbox, 'watch')).id).toBe('job-2')
    expect(starts[0]).toEqual([['$SHELL', 'serve'], { cwd: '/work', env: { PYTHONUNBUFFERED: '1' } }])
    expect(registry.running()).toBe(2)
  })

  it('returns new output on each read and carries on where the last read ended', async () => {
    const one = fakeProcess()
    const registry = new JobRegistry(clock)
    await start(registry, sandboxOf(one).sandbox)
    one.print('a\n')
    one.print('b\n')
    expect(await registry.output('job-1')).toMatchObject({ text: 'a\nb\n', next: 4, dropped: 0 })
    one.print('c\n')
    expect(await registry.output('job-1')).toMatchObject({ text: 'c\n', next: 6 })
    expect(await registry.output('job-1')).toMatchObject({ text: '', next: 6 })
    // An explicit `since` reads again from there.
    expect(await registry.output('job-1', { since: 2 })).toMatchObject({ text: 'b\nc\n', next: 6 })
  })

  it('keeps only the recent output and says how much a read missed', async () => {
    const one = fakeProcess()
    const registry = new JobRegistry(clock)
    await start(registry, sandboxOf(one).sandbox)
    one.print('x'.repeat(JOB_OUTPUT_KEEP))
    one.print('tail')
    const out = await registry.output('job-1', { since: 0 })
    expect(out.dropped).toBe(4)
    expect(out.text).toHaveLength(JOB_OUTPUT_KEEP)
    expect(out.text.endsWith('tail')).toBe(true)
    expect(out.next).toBe(JOB_OUTPUT_KEEP + 4)
  })

  it('waits for new output, or for the job to end, up to waitMs', async () => {
    vi.useFakeTimers()
    const one = fakeProcess()
    const registry = new JobRegistry(clock)
    await start(registry, sandboxOf(one).sandbox)
    const waiting = registry.output('job-1', { waitMs: 5000 })
    await vi.advanceTimersByTimeAsync(100)
    one.print('ready\n')
    expect(await waiting).toMatchObject({ text: 'ready\n', status: 'running' })
    const ending = registry.output('job-1', { waitMs: 5000 })
    one.exit({ code: 3 })
    expect(await ending).toMatchObject({ text: '', status: 'exited', code: 3 })
    const idle = fakeProcess()
    await start(registry, sandboxOf(idle).sandbox)
    const nothing = registry.output('job-2', { waitMs: 5000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await nothing).toMatchObject({ text: '', status: 'running' })
  })

  it('stops a job, calls it stopped rather than exited, and keeps its output readable', async () => {
    const one = fakeProcess()
    const registry = new JobRegistry(clock)
    await start(registry, sandboxOf(one).sandbox)
    one.print('bye\n')
    expect(await registry.stop('job-1')).toMatchObject({ status: 'stopped' })
    expect(one.stop).toHaveBeenCalledTimes(1)
    expect(await registry.output('job-1')).toMatchObject({ text: 'bye\n', status: 'stopped' })
    expect(registry.running()).toBe(0)
  })

  it('refuses a job beyond the running limit, and counts a finished one out of it', async () => {
    const processes = Array.from({ length: MAX_RUNNING_JOBS + 1 }, fakeProcess)
    const { sandbox } = sandboxOf(...processes)
    const registry = new JobRegistry(clock)
    for (let n = 0; n < MAX_RUNNING_JOBS; n++) await start(registry, sandbox)
    await expect(start(registry, sandbox)).rejects.toMatchObject({ code: 'E_JOB_LIMIT' })
    processes[0]?.exit({ code: 0 })
    await vi.waitFor(() => expect(registry.running()).toBe(MAX_RUNNING_JOBS - 1))
    await expect(start(registry, sandbox)).resolves.toMatchObject({ id: `job-${MAX_RUNNING_JOBS + 1}` })
  })

  it('names an unknown job and says jobs end with their session', async () => {
    const registry = new JobRegistry(clock)
    await expect(registry.output('job-7')).rejects.toMatchObject({ code: 'E_JOB_UNKNOWN' })
    await expect(registry.stop('job-7')).rejects.toThrow(/jobs end when the session that started them closes/)
  })

  it('refuses where the workspace cannot start a background process', async () => {
    await expect(
      new JobRegistry(clock).start({}, ['$SHELL', 'x'], { cwd: '/w', command: 'x' }),
    ).rejects.toMatchObject({ code: 'E_JOB_UNAVAILABLE' })
  })

  it('stops every job on stopAll, the finished ones too, and starts none after', async () => {
    const running = fakeProcess()
    const finished = fakeProcess()
    const registry = new JobRegistry(clock)
    await start(registry, sandboxOf(running).sandbox)
    await start(registry, sandboxOf(finished).sandbox)
    finished.exit({ code: 0 })
    await vi.waitFor(() => expect(registry.list()[1]?.status).toBe('exited'))
    await registry.stopAll()
    expect(running.stop).toHaveBeenCalledTimes(1)
    // Stop is asked of a finished job too; its executor treats that as nothing to do.
    expect(finished.stop).toHaveBeenCalledTimes(1)
    expect(registry.list().map((job) => job.status)).toEqual(['stopped', 'exited'])
    await expect(start(registry, sandboxOf(fakeProcess()).sandbox)).rejects.toMatchObject({
      code: 'E_JOB_UNAVAILABLE',
    })
  })
})
