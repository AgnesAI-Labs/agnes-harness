import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { MemoryJournal } from '@agnes/daemon-foundation/local/ports'
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
      grants: [{ extension: 'agnes/jobs-web', name: params.service, range: '*' }],
    })
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
    expect(
      await call('control', { sessionId: 'read-only', operation: 'open', commandId: 'deny' }),
    ).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
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
