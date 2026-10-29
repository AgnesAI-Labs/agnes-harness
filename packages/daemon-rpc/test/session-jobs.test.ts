import { resolve } from 'node:path'
import { createJobsServiceFixture, fakeToolContext } from '@agnes/base/testkit'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { MemoryJournal } from '@agnes/daemon-foundation/local/ports'
import type { ProcessExit, ServiceContext } from '@agnes/extension-api'
import { createExtensionActivationBarrier, type Host } from '@agnes/host'
import { rpcError, type SessionJob } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { CommandQueue } from '../src/local/command-queue.js'
import { registerSessionJobs } from '../src/local/session-jobs.js'

it('uses narrow authenticated service grants, replays open receipts and refuses cross-session or agent controls', async () => {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' }),
    queue = new CommandQueue()
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.clientId = 'workbench-test'
  ep.conn.credential = { kind: 'local' }
  const jobs: SessionJob[] = [],
    effects: string[] = []
  const callService: Host['callService'] = async (params, credential) => {
    expect(credential).toMatchObject({
      source: 'session-workbench',
      subjectCredential: { kind: 'local' },
      grants: [{ extension: 'community/jobs', name: params.service, range: '*' }],
    })
    expect(params.extension).toBe('community/jobs')
    const own = jobs.filter((job) => job.ownerSessionId === params.sessionId)
    if (params.service === 'jobs.read')
      return { output: { jobs: own.map((job) => ({ ...job })), completions: [] } }
    effects.push(params.commandId ?? '')
    const job: SessionJob = {
      id: 'human-1',
      owner: 'human',
      ownerSessionId: params.sessionId,
      kind: 'pty',
      command: 'bash',
      cwd: '/workspace',
      status: 'running',
      code: null,
      truncated: false,
    }
    jobs.push(job)
    return { output: { ...job } }
  }
  registerSessionJobs(
    ep,
    {
      activationBarrier: createExtensionActivationBarrier(),
      journal: new MemoryJournal(Date.now),
      commandQueue: queue,
      resolveService: async (key, names) => {
        expect(names).toEqual(['jobs.read', 'jobs.control'])
        return key === 'disabled'
          ? undefined
          : { extension: 'community/jobs', packageId: '@community/jobs', workspaceRoot: '/workspace' }
      },
      callService,
      inspectService: async (p) => {
        if (p.sessionId === 'read-only' && p.service === 'jobs.control') throw rpcError('CAPABILITY_DENIED')
        return { kind: p.service === 'jobs.read' ? 'query' : 'effect' }
      },
    },
    (_method, sessionId) => {
      if (sessionId === 'foreign') throw rpcError('CAPABILITY_DENIED')
    },
  )
  let id = 0
  const call = (operation: 'read' | 'control', params: Record<string, unknown>) =>
    ep.handle({ jsonrpc: '2.0', id: ++id, method: `_agnes/v1/session.jobs.${operation}`, params })
  try {
    const open = { sessionId: 's1', commandId: 'open-once', operation: 'open' }
    expect(await call('control', open)).toMatchObject({
      result: { output: { owner: 'human', status: 'running' } },
    })
    expect(await call('control', open)).toMatchObject({ result: { output: { id: 'human-1' } } })
    expect(effects).toEqual(['open-once'])
    jobs.push({ ...jobs[0]!, id: 'agent-1', owner: 'agent' })
    for (const params of [
      { sessionId: 's2', jobId: 'human-1' },
      { sessionId: 's1', jobId: 'agent-1' },
      { sessionId: 'foreign', jobId: 'human-1' },
    ])
      expect(
        await call('control', {
          ...params,
          operation: 'kill',
          commandId: `kill-${params.sessionId}-${params.jobId}`,
        }),
      ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    for (const [sessionId, operation, extra] of [
      ['read-only', 'open', {}],
      ['read-only', 'run', { command: 'ls' }],
      ['foreign', 'run', { command: 'ls' }],
    ] as const)
      expect(
        await call('control', {
          sessionId,
          operation,
          commandId: `deny-${sessionId}-${operation}`,
          ...extra,
        }),
      ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    expect(await call('read', { sessionId: 'disabled' })).toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    expect(await call('read', { sessionId: 'foreign' })).toMatchObject({
      error: { data: { code: 'CAPABILITY_DENIED' } },
    })
    expect(await call('read', { sessionId: 's1' })).toMatchObject({
      result: { jobs: [{ owner: 'human' }, { owner: 'agent' }] },
    })
    expect(jobs.every((job) => job.status === 'running')).toBe(true)
    expect(effects).toEqual(['open-once'])
  } finally {
    await ep.close()
    await queue.close()
  }
})

it.each([undefined, 0, 3])(
  'validates real jobs service results through RPC with stoppedProcesses=%s',
  async (stoppedProcesses) => {
    const { jobs, services } = createJobsServiceFixture()
    const tool = fakeToolContext({ sessionKey: 's1', cwd: resolve('/work/proj') })
    const receipt = { code: 0, ...(stoppedProcesses === undefined ? {} : { stoppedProcesses }) }
    let finish!: (exit: ProcessExit) => void
    tool.sandbox.openProcess = async () => ({
      enforcement: { level: 'none', scope: [] },
      exited: new Promise((resolve) => {
        finish = resolve
      }),
      onOutput(listener) {
        listener({ stream: 'stdout', text: `out${'x'.repeat(65536)}` })
        listener({ stream: 'stderr', text: `err${'y'.repeat(65536)}` })
        return () => {}
      },
      write: async () => {},
      resize: async () => {},
      signal: async () => {},
      close: async () => finish(receipt),
    })
    const ctx: ServiceContext = { ...tool, source: 'test', requestId: 'r' }
    const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
    const queue = new CommandQueue()
    Object.assign(ep.conn, {
      initialized: true,
      authKind: 'local',
      clientId: 'real-jobs-test',
      credential: { kind: 'local' },
    })
    registerSessionJobs(
      ep,
      {
        activationBarrier: createExtensionActivationBarrier(),
        journal: new MemoryJournal(Date.now),
        commandQueue: queue,
        resolveService: async () => ({
          extension: 'base/jobs-web',
          packageId: '@agnes/base',
          workspaceRoot: tool.cwd,
        }),
        callService: async (params) => {
          const service = services.find((entry) => entry.name === params.service)!
          return { output: await service.handler(params.input, ctx) }
        },
        inspectService: async () => ({ kind: 'effect' }),
      },
      () => {},
    )
    let id = 0
    const call = (operation: 'read' | 'control', params = {}) =>
      ep.handle({
        jsonrpc: '2.0',
        id: ++id,
        method: `_agnes/v1/session.jobs.${operation}`,
        params: { sessionId: tool.session.key, ...params },
      })
    try {
      const job = await jobs.start('synthetic command', tool.cwd, tool)
      finish(receipt)
      await Promise.resolve()
      expect(jobs.list(tool)[0]).toMatchObject({
        status: 'completed',
        ...(stoppedProcesses === undefined ? {} : { stoppedProcesses }),
      })
      const metadata = {
        id: job.id,
        owner: 'agent',
        ownerSessionId: 's1',
        kind: 'shell',
        command: 'synthetic command',
        cwd: tool.cwd,
        status: 'completed',
        code: 0,
        truncated: true,
      }
      // LocalEndpoint checks the real protocol result schema, including all nested job records.
      expect(await call('read')).toMatchObject({
        result: { jobs: [metadata], completions: [{ ...metadata, truncated: false }] },
      })
      expect(await call('read', { jobId: job.id })).toMatchObject({
        result: { job: { ...metadata, stdout: 'x'.repeat(65536), stderr: 'y'.repeat(65536) } },
      })
      const opened = await call('control', { operation: 'open', commandId: 'open' })
      expect(opened).toMatchObject({ result: { output: { owner: 'human', kind: 'pty', shell: 'bash' } } })
      const terminal = jobs.list(tool).find((entry) => entry.owner === 'human')!
      for (const input of [
        { operation: 'send', text: 'hello' },
        { operation: 'resize', columns: 80, rows: 24 },
        { operation: 'signal', signal: 'SIGINT' },
      ])
        expect(
          await call('control', { ...input, jobId: terminal.id, commandId: input.operation }),
        ).toMatchObject({ result: { output: { ok: true } } })
      expect(
        await call('control', { operation: 'kill', jobId: terminal.id, commandId: 'kill' }),
      ).toMatchObject({ result: { output: { id: terminal.id, status: 'killed', truncated: true } } })
      expect(await call('read', { jobId: terminal.id })).toMatchObject({
        result: { job: { id: terminal.id, status: 'killed' } },
      })
      // `run` returns a human-owned, non-PTY shell job that passes the result schema.
      expect(await call('control', { operation: 'run', command: 'ls', commandId: 'run' })).toMatchObject({
        result: { output: { owner: 'human', kind: 'shell', command: 'ls', status: 'running' } },
      })
      for (const params of [
        { command: '' },
        { command: 'x'.repeat(8193) },
        { command: 'a\0b' },
        { command: 'ls', timeoutMs: 999 },
        { command: 'ls', timeoutMs: 600001 },
        { command: 'ls', timeoutMs: 1.5 },
        {},
      ])
        expect(await call('control', { operation: 'run', commandId: 'bad', ...params })).toMatchObject({
          error: { code: -32602 },
        })
    } finally {
      await jobs.dispose()
      await ep.close()
      await queue.close()
    }
  },
)
