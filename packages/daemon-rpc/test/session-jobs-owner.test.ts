import { resolve } from 'node:path'
import { createJobsServiceFixture, fakeToolContext } from '@agnes/base/testkit'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { MemoryJournal } from '@agnes/daemon-foundation/local/ports'
import type { ServiceContext } from '@agnes/extension-api'
import { createExtensionActivationBarrier } from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { CommandQueue } from '../src/local/command-queue.js'
import { registerSessionJobs } from '../src/local/session-jobs.js'

it('lets the session owner stop an agent job through RPC while other principals, sessions and controls stay refused', async () => {
  const { jobs, services } = createJobsServiceFixture()
  const tool = fakeToolContext({ sessionKey: 's1', cwd: resolve('/work/proj') })
  const processes: { closed: boolean }[] = []
  tool.sandbox.openProcess = async () => {
    let end!: () => void
    const exited = new Promise<{ code: number }>((resolve) => {
      end = () => resolve({ code: 0 })
    })
    const process = { closed: false }
    processes.push(process)
    return {
      enforcement: { level: 'none', scope: [] },
      exited,
      onOutput: () => () => {},
      write: async () => {},
      resize: async () => {},
      signal: async () => {},
      close: async () => {
        process.closed = true
        end()
      },
    }
  }
  const ctx: ServiceContext = { ...tool, source: 'test', requestId: 'r' }
  const queue = new CommandQueue()
  const endpoint = (principalId: string) => {
    const ep = new LocalEndpoint({ clock: Date.now, principalId })
    Object.assign(ep.conn, {
      initialized: true,
      authKind: 'local',
      clientId: `${principalId}-client`,
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
        // The fixture's service context is bound to s1, so session scoping below is the RPC check's.
        callService: async (params) => {
          const service = services.find((entry) => entry.name === params.service)
          if (!service) throw new Error(`unknown service ${params.service}`)
          return { output: await service.handler(params.input, ctx) }
        },
        inspectService: async (p) => ({ kind: p.service === 'jobs.read' ? 'query' : 'effect' }),
      },
      (method, sessionId, call) => {
        if (call.conn.principalId !== 'owner')
          throw rpcError('CAPABILITY_DENIED', { method, sessionId, reason: 'session owner unavailable' })
      },
    )
    let id = 0
    return {
      ep,
      control: (params: Record<string, unknown>) =>
        ep.handle({
          jsonrpc: '2.0',
          id: ++id,
          method: '_agnes/v1/session.jobs.control',
          params: { sessionId: 's1', ...params },
        }),
    }
  }
  const owner = endpoint('owner'),
    intruder = endpoint('intruder')
  const denied = { error: { data: { code: 'CAPABILITY_DENIED' } } }
  try {
    const agent = await jobs.openTerminal(tool, 'bash')
    const opened = await owner.control({ operation: 'open', commandId: 'open' })
    const human = (opened as { result: { output: { id: string; owner: string } } }).result.output
    expect(human.owner).toBe('human')

    expect(await intruder.control({ operation: 'kill', jobId: agent.id, commandId: 'k1' })).toMatchObject(
      denied,
    )
    expect(
      await owner.control({ sessionId: 's2', operation: 'kill', jobId: agent.id, commandId: 'k2' }),
    ).toMatchObject(denied)
    expect(
      await owner.control({ operation: 'signal', signal: 'SIGINT', jobId: agent.id, commandId: 's1' }),
    ).toMatchObject(denied)
    expect(await intruder.control({ operation: 'kill', jobId: human.id, commandId: 'k3' })).toMatchObject(
      denied,
    )
    expect(processes.map((process) => process.closed)).toEqual([false, false])

    expect(await owner.control({ operation: 'kill', jobId: agent.id, commandId: 'k4' })).toMatchObject({
      result: { output: { id: agent.id, owner: 'agent', status: 'killed' } },
    })
    expect(processes[0]?.closed, 'the agent job process is stopped').toBe(true)
    expect(await owner.control({ operation: 'kill', jobId: human.id, commandId: 'k5' })).toMatchObject({
      result: { output: { id: human.id, owner: 'human', status: 'killed' } },
    })
    expect(processes[1]?.closed).toBe(true)
  } finally {
    await jobs.dispose()
    await owner.ep.close()
    await intruder.ep.close()
    await queue.close()
  }
})
