import { resolve } from 'node:path'
import type { ServiceContext } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { ShellJobs } from '../src/registry.js'
import { createJobsServices } from '../src/services.js'

it('lets the session stop its own agent jobs but keeps every other agent-job control and foreign session refused', async () => {
  const jobs = new ShellJobs(),
    tool = fakeToolContext({ cwd: resolve('/work/proj'), sessionKey: 'owner-session' })
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
  const ctx = { ...tool, source: 'test', requestId: 'r', timeoutMs: 1000 } as ServiceContext
  const foreign = { ...ctx, session: { ...tool.session, key: 'foreign-session' } } as ServiceContext
  const control = createJobsServices(jobs)[1]
  if (!control) throw new Error('jobs.control service missing')
  try {
    const agent = await jobs.openTerminal(tool, 'bash')
    const human = (await control.handler({ operation: 'open' }, ctx)) as { id: string }
    expect(jobs.list(tool)).toMatchObject([
      { id: agent.id, owner: 'agent', status: 'running' },
      { id: human.id, owner: 'human', status: 'running' },
    ])

    // Another session's service context does not see this session's jobs at all.
    await expect(control.handler({ operation: 'kill', jobId: agent.id }, foreign)).rejects.toThrow(
      'CAPABILITY_DENIED',
    )
    // Stopping is the only control the session gains over agent jobs; input and signals stay the model's.
    for (const input of [
      { operation: 'send', text: 'no' },
      { operation: 'resize', columns: 80, rows: 24 },
      { operation: 'signal', signal: 'SIGINT' },
    ])
      await expect(control.handler({ ...input, jobId: agent.id }, ctx)).rejects.toThrow('CAPABILITY_DENIED')
    expect(processes.map((process) => process.closed)).toEqual([false, false])

    expect(await control.handler({ operation: 'kill', jobId: agent.id }, ctx)).toMatchObject({
      id: agent.id,
      owner: 'agent',
      status: 'killed',
    })
    expect(processes[0]?.closed, 'the agent job process is stopped').toBe(true)
    expect(await control.handler({ operation: 'kill', jobId: human.id }, ctx)).toMatchObject({
      id: human.id,
      owner: 'human',
      status: 'killed',
    })
    expect(processes[1]?.closed).toBe(true)
  } finally {
    await jobs.dispose()
  }
})
