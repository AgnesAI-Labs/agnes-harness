import { resolve } from 'node:path'
import type { ServiceContext } from '@agnes/extension-api'
import { validateMethod } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
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

it('refuses grandchild and ambiguous child kills without touching cancel, isolates >128 paused descendants, and preserves childStatus/childLabel', async () => {
  const jobs = new ShellJobs()
  const tool = fakeToolContext({ cwd: resolve('/work/proj'), sessionKey: 'root-session' })
  let sent = ''
  tool.sandbox.openProcess = async () => {
    let end!: () => void
    const exited = new Promise<{ code: number }>((resolve) => {
      end = () => resolve({ code: 0 })
    })
    return {
      enforcement: { level: 'none', scope: [] },
      exited,
      onOutput: () => () => {},
      write: async (text) => {
        sent += text
      },
      resize: async () => {},
      signal: async () => {},
      close: async () => end(),
    }
  }

  const descendants = Array.from({ length: 135 }, (_, idx) => ({
    id: `gc-${idx}`,
    providerId: 'in-process',
    status: 'paused' as const,
    continuable: true,
    label: `Paused descendant ${idx}`,
    ownerSessionId: 'direct-1',
    direct: false,
    readOnly: true,
  }))
  const directRows = [
    {
      id: 'direct-1',
      providerId: 'in-process',
      status: 'waiting_approval' as const,
      continuable: true,
      label: 'Direct approval task',
      ownerSessionId: 'root-session',
      direct: true,
      readOnly: false,
    },
    {
      id: 'dup-1',
      providerId: 'in-process',
      status: 'running' as const,
      continuable: true,
      label: 'Ambiguous child',
      ownerSessionId: 'root-session',
      direct: false,
      readOnly: true,
      ambiguous: true,
    },
  ]
  const allRows = [...directRows, ...descendants]
  const listSpy = vi.fn(async () => allRows)
  const readDetailSpy = vi.fn(async (id: string) => {
    const found = allRows.find((row) => row.id === id)
    return found ? { ...found, text: `detail-body:${id}` } : undefined
  })
  const readDirectSpy = vi.fn(async (id: string) => directRows.find((row) => row.id === id))
  const cancelSpy = vi.fn(async () => {})
  const childJobs = {
    list: listSpy,
    readDetail: readDetailSpy,
    readDirect: readDirectSpy,
    cancel: cancelSpy,
  }
  const ctx = {
    ...tool,
    source: 'test',
    requestId: 'r',
    timeoutMs: 1000,
    childJobs,
  } as ServiceContext
  const [read, control] = createJobsServices(jobs)
  if (!read || !control) throw new Error('jobs services missing')
  try {
    // Open a direct human terminal first.
    const human = (await control.handler({ operation: 'open' }, ctx)) as { id: string }
    // Opening a human terminal must not trigger full-tree child listing.
    expect(listSpy).not.toHaveBeenCalled()

    // Reading list with 135 paused descendants succeeds, stays <= 128 items, passes protocol schema,
    // keeps the direct human terminal, and exposes childStatus/childLabel.
    const listed = (await read.handler({}, ctx)) as {
      jobs: Array<Record<string, unknown>>
      completions: Array<Record<string, unknown>>
    }
    expect(validateMethod('_agnes/v1/session.jobs.read', 'result', listed)).toMatchObject({ ok: true })
    expect(listed.jobs.length).toBeLessThanOrEqual(128)
    expect(listed.jobs.some((row) => row.id === human.id)).toBe(true)
    expect(listed.jobs.find((row) => row.id === 'child:direct-1')).toMatchObject({
      childStatus: 'waiting_approval',
      childLabel: 'Direct approval task',
    })
    expect(readDetailSpy).not.toHaveBeenCalled()

    // Reading a specific descendant past slot 128 fetches ONLY its detail body and validates cleanly.
    const specific = (await read.handler({ jobId: 'child:gc-134' }, ctx)) as {
      jobs: Array<Record<string, unknown>>
      job: Record<string, unknown>
    }
    expect(validateMethod('_agnes/v1/session.jobs.read', 'result', specific)).toMatchObject({ ok: true })
    expect(specific.jobs.length).toBeLessThanOrEqual(128)
    expect(specific.job).toMatchObject({
      id: 'child:gc-134',
      ownerSessionId: 'direct-1',
      childStatus: 'paused',
      childLabel: 'Paused descendant 134',
      stdout: 'detail-body:gc-134',
    })
    expect(readDetailSpy).toHaveBeenCalledTimes(1)
    expect(readDetailSpy).toHaveBeenCalledWith('gc-134')

    // Reading a direct human terminal triggers zero child detail reads.
    const humanRead = (await read.handler({ jobId: human.id }, ctx)) as { job: Record<string, unknown> }
    expect(humanRead.job).toMatchObject({ id: human.id, owner: 'human' })
    expect(readDetailSpy).toHaveBeenCalledTimes(1)

    // Controlling the existing direct human terminal works without materializing the child tree.
    const listsBeforeControl = listSpy.mock.calls.length
    await control.handler({ operation: 'send', jobId: human.id, text: 'pwd\n' }, ctx)
    expect(sent).toBe('pwd\n')
    expect(listSpy.mock.calls.length).toBe(listsBeforeControl)

    // Killing a read-only grandchild or an ambiguous child is refused fail-closed without touching cancel.
    await expect(control.handler({ operation: 'kill', jobId: 'child:gc-0' }, ctx)).rejects.toThrow(
      'CAPABILITY_DENIED',
    )
    await expect(control.handler({ operation: 'kill', jobId: 'child:dup-1' }, ctx)).rejects.toThrow(
      'CAPABILITY_DENIED',
    )
    await expect(jobs.kill(tool, 'child:gc-0')).rejects.toThrow('CAPABILITY_DENIED')
    expect(cancelSpy).not.toHaveBeenCalled()
    expect(listSpy.mock.calls.length).toBe(listsBeforeControl)

    // Killing an unambiguous direct child passes verified identity to cancel without full-tree sync.
    const killed = (await control.handler({ operation: 'kill', jobId: 'child:direct-1' }, ctx)) as Record<
      string,
      unknown
    >
    expect(killed).toMatchObject({
      id: 'child:direct-1',
      status: 'killed',
      code: -1,
      childStatus: 'cancelled',
    })
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledWith('direct-1', {
      providerId: 'in-process',
      ownerSessionId: 'root-session',
    })
    expect(listSpy.mock.calls.length).toBe(listsBeforeControl)
  } finally {
    await jobs.dispose()
  }
})
