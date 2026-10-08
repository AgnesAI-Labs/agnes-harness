import type { ServiceContext } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createJobTools } from '../src/index.js'
import { ShellJobs } from '../src/registry.js'
import { createJobsServices } from '../src/services.js'

it('unifies child output/cancellation with owner isolation and completion notifications', async () => {
  const jobs = new ShellJobs(),
    ctx = fakeToolContext({ sessionKey: 'parent' })
  let cancelled = false
  ctx.subagent.list = async () => [
    {
      id: 'child-1',
      providerId: 'acp',
      status: cancelled ? 'cancelled' : 'running',
      continuable: true,
    },
  ]
  ctx.subagent.collect = async (childKey) => ({
    childKey,
    status: cancelled ? 'cancelled' : 'running',
    text: 'child output',
  })
  ctx.subagent.cancel = async () => {
    cancelled = true
    return { childKey: 'child-1', status: 'cancelled' }
  }
  const [list, output, kill] = createJobTools(jobs)
  expect(JSON.stringify(await list!.execute({}, ctx))).toContain('child:child-1')
  expect(JSON.stringify(await output!.execute({ jobId: 'child:child-1' }, ctx))).toContain('child output')
  expect(
    (await output!.execute({ jobId: 'child:child-1' }, fakeToolContext({ sessionKey: 'foreign' }))).isError,
  ).toBe(true)
  await kill!.execute({ jobId: 'child:child-1' }, ctx)
  expect(cancelled).toBe(true)
  expect(jobs.completions(ctx)).toMatchObject([{ id: 'child:child-1', kind: 'child', status: 'killed' }])
  await jobs.dispose()
})
it('refuses a query-side launch or a service without Host session identity', async () => {
  const jobs = new ShellJobs(),
    tool = fakeToolContext()
  const [read, control] = createJobsServices(jobs)
  const context: ServiceContext = {
    actor: tool.actor,
    source: 'test',
    requestId: 'r',
    cwd: tool.cwd,
    exec: tool.exec,
    fs: tool.fs,
    net: tool.net,
    artifacts: tool.artifacts,
    authorize: tool.authorize,
    platform: tool.platform,
    signal: tool.signal,
    timeoutMs: 1000,
    log: tool.log,
  }
  await expect(read!.handler({}, context)).rejects.toThrow('session-bound')
  await expect(
    control!.handler({ operation: 'open' }, { ...context, session: tool.session }),
  ).rejects.toThrow('SANDBOX_UNAVAILABLE')
  expect(jobs.list(tool)).toEqual([])
})

it('joins a launch racing session shutdown and never republishes its process', async () => {
  const jobs = new ShellJobs(),
    ctx = fakeToolContext()
  let release!: (handle: import('@agnes/extension-api').SandboxProcess) => void
  const opened = new Promise<import('@agnes/extension-api').SandboxProcess>((resolve) => {
    release = resolve
  })
  ctx.sandbox.openProcess = () => opened
  let closed = false
  const launching = jobs.openTerminal(ctx, 'bash')
  await Promise.resolve()
  const shutdown = jobs.closeSession(ctx.session.key)
  release({
    enforcement: { level: 'none', scope: [] },
    exited: Promise.resolve({ code: 0 }),
    onOutput: () => () => {},
    write: async () => {},
    resize: async () => {},
    signal: async () => {},
    close: async () => {
      closed = true
    },
  })
  await expect(launching).rejects.toThrow('closed during launch')
  await shutdown
  expect(closed).toBe(true)
  expect(jobs.list(ctx)).toEqual([])
})

it('keeps backend origin, isolates controls and reports slow or capped output without closing jobs on reads', async () => {
  const jobs = new ShellJobs(),
    tool = fakeToolContext({ sessionKey: 'terminal-session' })
  const processes: { emit(text: string): void; end(): void; input: string; closed: boolean }[] = []
  tool.sandbox.openProcess = async () => {
    let listener: (chunk: { stream: 'stdout'; text: string }) => void = () => {}
    let end!: () => void
    const exited = new Promise<{ code: number }>((resolve) => {
      end = () => resolve({ code: 0 })
    })
    const process = {
      emit(text: string) {
        listener({ stream: 'stdout', text })
      },
      end,
      input: '',
      closed: false,
    }
    processes.push(process)
    return {
      enforcement: { level: 'none', scope: [] },
      exited,
      onOutput(fn) {
        listener = fn
        return () => {
          listener = () => {}
        }
      },
      write: async (text) => {
        process.input += text
      },
      resize: async () => {},
      signal: async () => {},
      close: async () => {
        process.closed = true
        end()
      },
    }
  }
  const ctx = { ...tool, source: 'test', requestId: 'r', timeoutMs: 1000 } as ServiceContext
  const [read, control] = createJobsServices(jobs)
  try {
    const agent = await jobs.openTerminal(tool, 'bash')
    const opened = (await control!.handler({ operation: 'open' }, ctx)) as { id: string }
    expect(jobs.list(tool)).toMatchObject([
      { id: agent.id, owner: 'agent', ownerSessionId: tool.session.key, status: 'running' },
      { id: opened.id, owner: 'human', ownerSessionId: tool.session.key, status: 'running' },
    ])
    for (const input of [
      { operation: 'send', text: 'no' },
      { operation: 'resize', columns: 80, rows: 24 },
      { operation: 'signal', signal: 'SIGINT' },
      { operation: 'kill' },
    ])
      await expect(control!.handler({ ...input, jobId: agent.id }, ctx)).rejects.toThrow('CAPABILITY_DENIED')
    await expect(
      read!.handler({ jobId: opened.id }, { ...ctx, session: { ...tool.session, key: 'foreign' } }),
    ).rejects.toThrow('JOB_NOT_FOUND')
    await control!.handler({ operation: 'send', jobId: opened.id, text: 'hello' }, ctx)
    expect(processes[1]!.input).toBe('hello')
    processes[1]!.emit('BEGIN')
    expect(await read!.handler({ jobId: opened.id }, ctx)).toMatchObject({
      job: { stdout: 'BEGIN', status: 'running', truncated: false },
    })
    processes[1]!.emit('x'.repeat(70000))
    expect(await read!.handler({ jobId: opened.id }, ctx)).toMatchObject({
      job: { truncated: true, stdout: 'x'.repeat(65536), status: 'running' },
    })
    processes[1]!.emit('x'.repeat(4 * 1024 * 1024))
    expect(jobs.list(tool).find((job) => job.id === opened.id)?.truncated).toBe(true)
    expect(processes.every((process) => !process.closed)).toBe(true)
    processes[1]!.end()
    await Promise.resolve()
    expect(await read!.handler({ jobId: opened.id }, ctx)).toMatchObject({
      job: { status: 'completed', code: 0 },
    })
    expect(jobs.list(tool).find((job) => job.id === agent.id)?.status).toBe('running')
  } finally {
    await jobs.dispose()
  }
})
