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
  const directRows: Array<{
    id: string
    providerId: string
    status: import('@agnes/extension-api').ChildAgentStatus
    continuable: boolean
    label: string
    ownerSessionId: string
    direct: boolean
    readOnly: boolean
    ambiguous?: boolean
  }> = [
    {
      id: 'direct-1',
      providerId: 'in-process',
      status: 'waiting_approval',
      continuable: true,
      label: 'Direct approval task',
      ownerSessionId: 'root-session',
      direct: true,
      readOnly: false,
    },
    {
      id: 'dup-1',
      providerId: 'in-process',
      status: 'running',
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
  const cancelSpy = vi.fn(async (id: string) => {
    const row = directRows.find((entry) => entry.id === id)
    if (row) row.status = 'cancelled'
  })
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

it('does not finish or publish completion on unconfirmed cancelling stop and preserves race-winning terminal outcomes (P1-C)', async () => {
  const jobs = new ShellJobs()
  const [read, control] = createJobsServices(jobs)
  if (!read || !control) throw new Error('jobs services missing')
  type Row = {
    id: string
    providerId: string
    status: import('@agnes/extension-api').ChildAgentStatus
    executionState?: import('@agnes/extension-api').ChildExecutionState
    continuable: boolean
    text?: string
  }
  const rows = new Map<string, Row>([
    [
      'owned',
      {
        id: 'owned',
        providerId: 'in-process',
        status: 'running',
        executionState: 'running',
        continuable: true,
      },
    ],
    [
      'race-completed',
      {
        id: 'race-completed',
        providerId: 'in-process',
        status: 'running',
        executionState: 'running',
        continuable: true,
      },
    ],
    [
      'race-failed',
      {
        id: 'race-failed',
        providerId: 'in-process',
        status: 'running',
        executionState: 'running',
        continuable: true,
      },
    ],
  ])
  const tool = fakeToolContext({ cwd: resolve('/work/proj'), sessionKey: 'root' })
  const ctx = {
    ...tool,
    source: 'test',
    requestId: 'r',
    timeoutMs: 1000,
    childJobs: {
      list: async () => [...rows.values()],
      readDirect: async (id: string) => rows.get(id),
      cancel: async (id: string) => {
        const cur = rows.get(id)
        if (!cur) return
        if (id === 'owned') rows.set(id, { ...cur, status: 'running', executionState: 'cancelling' })
        else if (id === 'race-completed')
          rows.set(id, { ...cur, status: 'completed', executionState: 'completed', text: 'finished output' })
        else if (id === 'race-failed') rows.set(id, { ...cur, status: 'failed', executionState: 'failed' })
      },
    },
  } as unknown as ServiceContext
  try {
    // 1. Unconfirmed stop (executionState='cancelling'): remains running/running/null with 0 completions.
    const receipt = (await control.handler({ operation: 'kill', jobId: 'child:owned' }, ctx)) as Record<
      string,
      unknown
    >
    expect(validateMethod('_agnes/v1/session.jobs.control', 'result', { output: receipt })).toMatchObject({
      ok: true,
    })
    expect(receipt).toMatchObject({
      id: 'child:owned',
      status: 'running',
      childStatus: 'running',
      code: null,
    })
    const pendingRead = (await read.handler({ jobId: 'child:owned' }, ctx)) as {
      job: Record<string, unknown>
      completions: Array<Record<string, unknown>>
    }
    expect(validateMethod('_agnes/v1/session.jobs.read', 'result', pendingRead)).toMatchObject({ ok: true })
    expect(pendingRead.job).toMatchObject({
      id: 'child:owned',
      status: 'running',
      childStatus: 'running',
      code: null,
    })
    expect(pendingRead.completions).toHaveLength(0)

    // Once durable cancellation actually settles, finish once and ignore stale non-terminal refreshes.
    rows.set('owned', {
      id: 'owned',
      providerId: 'in-process',
      status: 'cancelled',
      executionState: 'cancelled',
      continuable: false,
    })
    const settled = (await read.handler({ jobId: 'child:owned' }, ctx)) as {
      job: Record<string, unknown>
      completions: Array<Record<string, unknown>>
    }
    expect(settled.job).toMatchObject({
      id: 'child:owned',
      status: 'killed',
      childStatus: 'cancelled',
      code: -1,
    })
    expect(settled.completions).toHaveLength(1)
    expect(settled.completions[0]).toMatchObject({
      id: 'child:owned',
      status: 'killed',
      childStatus: 'cancelled',
      code: -1,
    })
    rows.set('owned', {
      id: 'owned',
      providerId: 'in-process',
      status: 'running',
      executionState: 'running',
      continuable: false,
    })
    const afterStale = (await read.handler({ jobId: 'child:owned' }, ctx)) as {
      job: Record<string, unknown>
      completions: Array<Record<string, unknown>>
    }
    expect(afterStale.job).toMatchObject({ status: 'killed', childStatus: 'cancelled', code: -1 })
    expect(afterStale.completions).toHaveLength(1)

    // 2. Race-winning completed and failed outcomes are preserved rather than overwritten as killed/cancelled.
    const wonCompleted = (await control.handler(
      { operation: 'kill', jobId: 'child:race-completed' },
      ctx,
    )) as Record<string, unknown>
    expect(wonCompleted).toMatchObject({
      id: 'child:race-completed',
      status: 'completed',
      childStatus: 'completed',
      code: 0,
    })
    const wonFailed = (await control.handler(
      { operation: 'kill', jobId: 'child:race-failed' },
      ctx,
    )) as Record<string, unknown>
    expect(wonFailed).toMatchObject({
      id: 'child:race-failed',
      status: 'failed',
      childStatus: 'failed',
      code: -1,
    })
    const afterRaces = (await read.handler({}, ctx)) as { completions: Array<Record<string, unknown>> }
    expect(afterRaces.completions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'child:race-completed',
          status: 'completed',
          childStatus: 'completed',
          code: 0,
        }),
        expect.objectContaining({
          id: 'child:race-failed',
          status: 'failed',
          childStatus: 'failed',
          code: -1,
        }),
      ]),
    )

    // 3. Round 4 P1-C: transient directory vanish after stop must NOT fabricate/lock cancelled;
    // when the same ID reappears with completed + output, jobs.read settles completed/code 0 once.
    const transient = new ShellJobs()
    const [tRead, tControl] = createJobsServices(transient)
    if (!tRead || !tControl) throw new Error('jobs services missing')
    let transientEntry: Row | undefined = {
      id: 'worker-1',
      providerId: 'test-provider',
      status: 'running',
      continuable: false,
    }
    const tCtx = {
      ...tool,
      source: 'test',
      requestId: 'r-transient',
      timeoutMs: 1000,
      childJobs: {
        list: async () => (transientEntry ? [transientEntry] : []),
        readDirect: async (id: string) => (id === 'worker-1' ? transientEntry : undefined),
        cancel: async (id: string) => {
          if (id === 'worker-1') transientEntry = undefined
        },
      },
    } as unknown as ServiceContext
    try {
      const stopReceipt = (await tControl.handler(
        { operation: 'kill', jobId: 'child:worker-1' },
        tCtx,
      )) as Record<string, unknown>
      expect(stopReceipt).toMatchObject({
        id: 'child:worker-1',
        status: 'running',
        childStatus: 'running',
        code: null,
      })
      const whileAbsent = (await tRead.handler({}, tCtx)) as {
        jobs: Array<Record<string, unknown>>
        completions: Array<Record<string, unknown>>
      }
      expect(whileAbsent.jobs).toEqual([])
      expect(whileAbsent.completions).toEqual([])

      // Provider reattaches same ID with authoritative completed result and output.
      transientEntry = {
        id: 'worker-1',
        providerId: 'test-provider',
        status: 'completed',
        continuable: false,
        text: 'done before cancellation settled',
      }
      const settledRead = (await tRead.handler({ jobId: 'child:worker-1' }, tCtx)) as {
        job: Record<string, unknown>
        completions: Array<Record<string, unknown>>
      }
      expect(validateMethod('_agnes/v1/session.jobs.read', 'result', settledRead)).toMatchObject({ ok: true })
      expect(settledRead.job).toMatchObject({
        id: 'child:worker-1',
        status: 'completed',
        childStatus: 'completed',
        code: 0,
        stdout: 'done before cancellation settled',
      })
      expect(settledRead.completions).toHaveLength(1)
      expect(settledRead.completions[0]).toMatchObject({
        id: 'child:worker-1',
        status: 'completed',
        childStatus: 'completed',
        code: 0,
      })
      // Repeated reads remain completed with exactly one completion notice.
      const repeatedRead = (await tRead.handler({ jobId: 'child:worker-1' }, tCtx)) as {
        job: Record<string, unknown>
        completions: Array<Record<string, unknown>>
      }
      expect(repeatedRead.job).toMatchObject({ status: 'completed', childStatus: 'completed', code: 0 })
      expect(repeatedRead.completions).toHaveLength(1)
    } finally {
      await transient.dispose()
    }
  } finally {
    await jobs.dispose()
  }
})

it('removes reclaimed active external children while preserving truncated descendants and terminal history (P2-#26)', async () => {
  const jobs = new ShellJobs()
  const [read] = createJobsServices(jobs)
  if (!read) throw new Error('jobs.read service missing')
  const tool = fakeToolContext({ cwd: resolve('/work/proj'), sessionKey: 'root' })
  const activeRow = {
    id: 'e1',
    ownerSessionId: 'root',
    direct: true,
    providerId: 'ext',
    status: 'running' as const,
    continuable: true,
    label: 'Example',
    text: 'old body',
  }
  const doneRow = {
    id: 'e-done',
    ownerSessionId: 'root',
    direct: true,
    providerId: 'ext',
    status: 'completed' as const,
    continuable: false,
    label: 'Completed child',
    text: 'final report',
  }
  let activeVisible = true
  let doneVisible = true
  const readDetail = vi.fn(async (id: string) => {
    if (id === 'e1') return activeVisible ? activeRow : undefined
    if (id === 'e-done') return doneVisible ? doneRow : undefined
    return undefined
  })
  const ctx = {
    ...tool,
    source: 'test',
    requestId: 'r',
    timeoutMs: 1000,
    childJobs: {
      list: async () => [...(activeVisible ? [activeRow] : []), ...(doneVisible ? [doneRow] : [])],
      readDetail,
    },
  } as unknown as ServiceContext
  try {
    const initial = (await read.handler({ jobId: 'child:e1' }, ctx)) as { job: Record<string, unknown> }
    expect(initial.job).toMatchObject({ id: 'child:e1', stdout: 'old body', status: 'running' })

    // Reclaim both from the source: active child disappears (JOB_NOT_FOUND + absent from jobs),
    // while already-terminal history stays inspectable.
    activeVisible = false
    doneVisible = false
    await expect(read.handler({ jobId: 'child:e1' }, ctx)).rejects.toThrow('JOB_NOT_FOUND')
    const listed = (await read.handler({}, ctx)) as { jobs: Array<Record<string, unknown>> }
    expect(listed.jobs.map((job) => job.id)).toEqual(['child:e-done'])
    expect(listed.jobs[0]).toMatchObject({ status: 'completed', childStatus: 'completed', code: 0 })

    // Reclaimed active child is also removed during a plain list read (without jobId) once readDetail confirms absence.
    activeVisible = true
    await read.handler({}, ctx)
    activeVisible = false
    const afterPlainList = (await read.handler({}, ctx)) as { jobs: Array<Record<string, unknown>> }
    expect(afterPlainList.jobs.some((job) => job.id === 'child:e1')).toBe(false)

    // When descendant list is truncated (>=128 descendants), a previously loaded descendant past slot 128
    // is NOT dropped by list() alone, and IS dropped once readDetail explicitly returns undefined.
    const truncatedDescendants = Array.from({ length: 128 }, (_, idx) => ({
      id: `d-${idx}`,
      ownerSessionId: 'p',
      direct: false,
      readOnly: true,
      providerId: 'in-process',
      status: 'paused' as const,
      continuable: true,
    }))
    let extraVisible = true
    const extraRow = {
      id: 'd-129',
      ownerSessionId: 'p',
      direct: false,
      readOnly: true,
      providerId: 'in-process',
      status: 'paused' as const,
      continuable: true,
      text: 'descendant 129',
    }
    const truncatedCtx = {
      ...tool,
      source: 'test',
      requestId: 'r',
      timeoutMs: 1000,
      childJobs: {
        list: async () => truncatedDescendants,
        readDetail: async (id: string) =>
          id === 'd-129'
            ? extraVisible
              ? extraRow
              : undefined
            : truncatedDescendants.find((r) => r.id === id),
      },
    } as unknown as ServiceContext
    const loadedExtra = (await read.handler({ jobId: 'child:d-129' }, truncatedCtx)) as {
      job: Record<string, unknown>
    }
    expect(loadedExtra.job).toMatchObject({ id: 'child:d-129', stdout: 'descendant 129' })
    await read.handler({}, truncatedCtx)
    expect(jobs.list(tool).some((job) => job.id === 'child:d-129')).toBe(true)
    extraVisible = false
    await expect(read.handler({ jobId: 'child:d-129' }, truncatedCtx)).rejects.toThrow('JOB_NOT_FOUND')
    expect(jobs.list(tool).some((job) => job.id === 'child:d-129')).toBe(false)
  } finally {
    await jobs.dispose()
  }
})

it.each([false, true])(
  'ignores stale stop response after replacement completed projection without dropping history or duplicating completions (P1-C, detachAgain=%s)',
  async (detachAgain) => {
    const jobs = new ShellJobs()
    const [read, control] = createJobsServices(jobs)
    if (!read || !control) throw new Error('jobs services missing')
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let resolveRelease!: () => void
    const release = new Promise<void>((resolve) => {
      resolveRelease = resolve
    })
    let visible:
      | {
          id: string
          providerId: string
          status: import('@agnes/extension-api').ChildAgentStatus
          continuable: boolean
          text?: string
        }
      | undefined = { id: 'worker', providerId: 'fixture', status: 'running', continuable: false }
    let hold = false
    const ctx = {
      ...fakeToolContext({ cwd: resolve('/work/proj'), sessionKey: 'root' }),
      source: 'test',
      requestId: 'r-stale-stop',
      timeoutMs: 1000,
      childJobs: {
        readDirect: async () => visible,
        readDetail: async () => {
          if (hold) {
            hold = false
            resolveStarted()
            await release
            return undefined
          }
          return visible
        },
        list: async () => (visible ? [visible] : []),
        cancel: async () => {
          visible = undefined
          hold = true
        },
      },
    } as unknown as ServiceContext
    const id = { jobId: 'child:worker' }
    try {
      const kill = control.handler({ ...id, operation: 'kill' }, ctx)
      await started
      const empty = (await read.handler({}, ctx)) as { jobs: Array<Record<string, unknown>> }
      expect(empty.jobs).toHaveLength(0)

      visible = { id: 'worker', providerId: 'fixture', status: 'completed', continuable: false, text: 'done' }
      const again = (await read.handler(id, ctx)) as {
        job: Record<string, unknown>
        completions: Array<Record<string, unknown>>
      }
      expect(again.job).toMatchObject({ status: 'completed', childStatus: 'completed', code: 0 })
      expect(again.completions).toHaveLength(1)

      resolveRelease()
      await kill

      if (detachAgain) {
        visible = undefined
        const history = (await read.handler({}, ctx)) as {
          jobs: Array<Record<string, unknown>>
          completions: Array<Record<string, unknown>>
        }
        expect(history.jobs.map((row) => [row.childStatus, row.code])).toEqual([['completed', 0]])
        expect(history.completions.map((row) => row.childStatus)).toEqual(['completed'])
        return
      }
      const last = (await read.handler(id, ctx)) as {
        job: Record<string, unknown>
        completions: Array<Record<string, unknown>>
      }
      expect(last.job).toMatchObject({ status: 'completed', childStatus: 'completed', code: 0 })
      expect(last.completions.map((row) => row.childStatus)).toEqual(['completed'])
    } finally {
      resolveRelease()
      await jobs.dispose()
    }
  },
)
