import { resolve } from 'node:path'
import type { ServiceContext } from '@agnes/extension-api'
import { validateMethod } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createJobTools } from '../src/index.js'
import { SHELL_IDLE_MS, ShellJobs, TERMINAL_IDLE_MS } from '../src/registry.js'
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
  const running = await output!.execute({ jobId: 'child:child-1' }, ctx)
  expect(JSON.stringify(running)).toContain('child output')
  expect(running.structured).toEqual({ jobId: 'child:child-1', status: 'running' })
  expect(
    (await output!.execute({ jobId: 'child:child-1' }, fakeToolContext({ sessionKey: 'foreign' }))).isError,
  ).toBe(true)
  expect((await kill!.execute({ jobId: 'child:child-1' }, ctx)).structured).toEqual({
    jobId: 'child:child-1',
    status: 'killed',
  })
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
    ctx = fakeToolContext({ cwd: resolve('/work/proj') })
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
    tool = fakeToolContext({ cwd: resolve('/work/proj'), sessionKey: 'terminal-session' })
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
    const legacy = await jobs.openTerminal(tool, 'powershell', tool.cwd, undefined, false)
    expect(legacy.shell).toBe('powershell')
    const snapshot = await read!.handler({ jobId: legacy.id }, ctx)
    expect(validateMethod('_agnes/v1/session.jobs.read', 'result', snapshot)).toMatchObject({ ok: true })
    expect(snapshot).toMatchObject({ job: { id: legacy.id, kind: 'shell-session' } })
    expect(snapshot).not.toHaveProperty('job.shell')
  } finally {
    await jobs.dispose()
  }
})

it('retains failed cleanup for explicit retry instead of discarding the owned handle', async () => {
  const jobs = new ShellJobs(),
    ctx = fakeToolContext({ sessionKey: 'cleanup-retry', cwd: resolve('/work/proj') })
  let finish!: (exit: import('@agnes/extension-api').ProcessExit) => void
  let failing = true
  ctx.sandbox.openProcess = async () => ({
    enforcement: { level: 'none', scope: [] },
    exited: new Promise((resolve) => {
      finish = resolve
    }),
    onOutput: () => () => {},
    write: async () => {},
    resize: async () => {},
    signal: async () => {},
    close: async () => {
      if (failing) throw new Error('cleanup failed')
    },
  })
  const job = await jobs.start('server', ctx.cwd, ctx)
  finish({ code: 0, error: new Error('cleanup failed') })
  expect((await jobs.wait(ctx, job.id, 10)).status).toBe('failed')
  await expect(jobs.closeSession(ctx.session.key)).rejects.toThrow('job shutdown failed')
  expect(jobs.list(ctx)).toHaveLength(1)
  failing = false
  await jobs.closeSession(ctx.session.key)
  expect(jobs.list(ctx)).toEqual([])
})

it('runs a human one-shot command with output, exit codes, a timeout kill and no model-context completion', async () => {
  vi.useFakeTimers()
  const jobs = new ShellJobs(),
    tool = fakeToolContext({ cwd: resolve('/work/proj'), sessionKey: 'run-session' })
  const procs: {
    argv: readonly string[]
    cwd: string | undefined
    signals: string[]
    closed: boolean
    emit(stream: 'stdout' | 'stderr', text: string): void
    end(code: number): void
  }[] = []
  tool.sandbox.openProcess = async (request) => {
    let listener: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void = () => {}
    let end!: (code: number) => void
    const exited = new Promise<{ code: number }>((done) => {
      end = (code) => done({ code })
    })
    const proc = {
      argv: request.argv,
      cwd: request.cwd,
      signals: [] as string[],
      closed: false,
      emit: (stream: 'stdout' | 'stderr', text: string) => listener({ stream, text }),
      end,
    }
    procs.push(proc)
    return {
      enforcement: { level: 'none', scope: [] },
      exited,
      onOutput(fn) {
        listener = fn
        return () => {}
      },
      write: async () => {},
      resize: async () => {},
      signal: async (signal) => {
        proc.signals.push(signal)
      },
      close: async () => {
        proc.closed = true
        end(137)
      },
    }
  }
  const ctx = { ...tool, source: 'test', requestId: 'r', timeoutMs: 1000 } as ServiceContext
  const [read, control] = createJobsServices(jobs)
  const run = async (input: Record<string, unknown>) =>
    (await control!.handler({ operation: 'run', ...input } as never, ctx)) as { id: string }
  try {
    const ok = await run({ command: 'ls -la' })
    expect(procs[0]).toMatchObject({ argv: ['sh', '-c', 'ls -la'], cwd: tool.cwd })
    expect(ok).toMatchObject({ owner: 'human', kind: 'shell', status: 'running', command: 'ls -la' })
    procs[0]!.emit('stdout', 'hello\n')
    procs[0]!.emit('stderr', 'warn\n')
    procs[0]!.end(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(await read!.handler({ jobId: ok.id }, ctx)).toMatchObject({
      job: { status: 'completed', code: 0, stdout: 'hello\n', stderr: 'warn\n' },
    })
    expect(validateMethod('_agnes/v1/session.jobs.control', 'result', { output: ok })).toMatchObject({
      ok: true,
    })

    const bad = await run({ command: 'false' })
    procs[1]!.end(3)
    await vi.advanceTimersByTimeAsync(0)
    expect(await read!.handler({ jobId: bad.id }, ctx)).toMatchObject({
      job: { status: 'failed', code: 3 },
    })

    // Output beyond the 64 KiB read window is reported as truncated.
    const big = await run({ command: 'yes' })
    procs[2]!.emit('stdout', 'x'.repeat(70000))
    expect(await read!.handler({ jobId: big.id }, ctx)).toMatchObject({
      job: { truncated: true, stdout: 'x'.repeat(65536) },
    })
    // A human can interrupt it through the existing signal control.
    await control!.handler({ operation: 'signal', jobId: big.id, signal: 'SIGINT' }, ctx)
    expect(procs[2]!.signals).toEqual(['SIGINT'])
    procs[2]!.end(130)
    await vi.advanceTimersByTimeAsync(0)

    // The timeout sends SIGTERM, then closes the process after 2 s and reports `killed`.
    const slow = await run({ command: 'sleep 999', timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(procs[3]!.signals).toEqual(['SIGTERM'])
    expect(procs[3]!.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(procs[3]!.closed).toBe(true)
    expect(await read!.handler({ jobId: slow.id }, ctx)).toMatchObject({ job: { status: 'killed' } })

    // Human `run` jobs never reach the "Jobs completed" queue; agent terminals still do.
    expect(jobs.completions(tool)).toEqual([])
    const agent = await jobs.openTerminal(tool, 'bash')
    procs[4]!.end(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(jobs.completions(tool)).toMatchObject([{ id: agent.id, status: 'completed' }])

    for (const input of [
      { command: '' },
      { command: 'a\0b' },
      { command: 'x'.repeat(8193) },
      { command: 'ls', timeoutMs: 999 },
      { command: 'ls', timeoutMs: 600001 },
    ])
      await expect(run(input)).rejects.toThrow(/invalid/)
    expect(procs).toHaveLength(5)
    const noSandbox = { ...ctx } as { sandbox?: unknown }
    delete noSandbox.sandbox
    await expect(
      control!.handler({ operation: 'run', command: 'ls' }, noSandbox as ServiceContext),
    ).rejects.toThrow('SANDBOX_UNAVAILABLE')
  } finally {
    vi.useRealTimers()
    await jobs.dispose()
  }
})

function fakeProcesses(tool: ReturnType<typeof fakeToolContext>) {
  const opened: { argv: string[]; closed: boolean }[] = []
  tool.sandbox.openProcess = async (request) => {
    let end!: () => void
    const exited = new Promise<{ code: number }>((resolve) => {
      end = () => resolve({ code: 0 })
    })
    const record = { argv: request.argv, closed: false }
    opened.push(record)
    return {
      enforcement: { level: 'none', scope: [] },
      exited,
      onOutput: () => () => {},
      write: async () => {},
      resize: async () => {},
      signal: async () => {},
      close: async () => {
        record.closed = true
        end()
      },
    }
  }
  return opened
}

it('closes an idle persistent shell and an idle terminal, but not a busy shell or a read terminal', async () => {
  const jobs = new ShellJobs(),
    tool = fakeToolContext({ cwd: resolve('/work/proj'), sessionKey: 'idle-session' })
  fakeProcesses(tool)
  try {
    const shell = await jobs.openTerminal(tool, 'bash', tool.cwd, undefined, false)
    const busy = await jobs.openTerminal(tool, 'bash', tool.cwd, undefined, false)
    const terminal = await jobs.openTerminal(tool, 'bash')
    // A command that never finishes keeps its shell busy.
    await jobs.startPersistent('sleep 1000', undefined, tool, 'bash', busy.id)
    const status = (id: string) => jobs.list(tool).find((job) => job.id === id)?.status
    await jobs.closeIdle(Date.now() + SHELL_IDLE_MS - 1000)
    expect([status(shell.id), status(busy.id), status(terminal.id)]).toEqual([
      'running',
      'running',
      'running',
    ])
    await jobs.closeIdle(Date.now() + SHELL_IDLE_MS + 1000)
    expect([status(shell.id), status(busy.id), status(terminal.id)]).toEqual(['killed', 'running', 'running'])
    // Reading a terminal (the Web dock polls its output) counts as use.
    await jobs.wait({ ...tool, signal: tool.signal }, terminal.id, 0)
    await jobs.closeIdle(Date.now() + TERMINAL_IDLE_MS - 1000)
    expect(status(terminal.id)).toBe('running')
    await jobs.closeIdle(Date.now() + TERMINAL_IDLE_MS + 1000)
    expect(status(terminal.id)).toBe('killed')
  } finally {
    await jobs.dispose()
  }
})

it('runs a model command with its input at /dev/null, so a prompt fails instead of hanging', async () => {
  const jobs = new ShellJobs(),
    tool = fakeToolContext({ cwd: resolve('/work/proj') })
  const opened = fakeProcesses(tool)
  try {
    await jobs.start('npm init', tool.cwd, tool)
    expect(opened.at(-1)?.argv).toEqual(['sh', '-c', 'exec </dev/null; npm init'])
  } finally {
    await jobs.dispose()
  }
})
