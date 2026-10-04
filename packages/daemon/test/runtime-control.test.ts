import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { HostSession } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { SessionRuntimeControlParams } from '@agnes/protocol'
import { createClient, localAuth } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { RemoteSession } from '../src/supervisor/remote-session.js'
import type { WorkerSessionChannel } from '../src/supervisor/worker-link.js'
import { handleCommand } from '../src/worker/commands.js'
import { testWorkspaceCatalog } from './host.js'

const identity = { id: 'jevloop', version: '1' }
const actor = { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const input: Omit<SessionRuntimeControlParams, 'sessionId'> = {
  expectedRuntime: identity,
  operation: 'jev.resolveUnknown',
  payload: {
    intentId: 'unknown-intent',
    resolution: 'accepted_uncertainty',
    explanation: ' Operator inspected disk ',
    evidence: [' recorded receipt '],
  },
}

async function records(session: HostSession) {
  return (await session.scan({ type: 'runtime/record', toSeq: session.lastSeq, limit: 1000 })).map((row) => ({
    cursor: row.seq,
    record: (row.data as { record: Record<string, unknown> }).record,
  }))
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agnes-runtime-control-'))
  const provider = new ScriptedProvider({ scripts: [] })
  const invoke = vi.fn(async () => {
    throw new Error('Maintenance must not call a decision model')
  })
  const { host } = await createTestHost({
    dataDir: root,
    provider,
    disableSessionTitle: true,
    jev: {
      decision: {
        backend: 'jev',
        endpoint: 'https://decision.invalid',
        model: 'synthetic',
        transport: { invoke },
      },
    },
  })
  const workspaces = await testWorkspaceCatalog(root)
  const clients: ReturnType<typeof createClient>[] = []
  const client = (principalId = 'local') => {
    const endpoint = createLocalEndpoint(host, {
      workspaces,
      identity: { principalId, authKind: 'local', credentialKind: 'local' },
    })
    const value = createClient({
      transport: { kind: 'inproc', endpoint },
      authProviders: { local: () => localAuth() },
    })
    clients.push(value)
    return value
  }
  const first = client()
  const created = await first.session.new({ cwd: root, runtime: 'jevloop' })
  const live = () => {
    const session = host.kernel.get(created.id)
    if (!session) throw new Error('Fixture session is not open')
    return session
  }
  const seed = live()
  const base = { version: 1 as const, turn: 'original-turn' }
  const prefix = [
    {
      ...base,
      id: 'decision-request',
      kind: 'model.requested',
      call: {
        purpose: 'decision',
        backend: 'synthetic',
        endpoint: 'local',
        codec: 'fixture',
        requestedModel: 'synthetic',
        inputCursor: null,
        input: {},
      },
    },
    {
      ...base,
      id: 'decision-output',
      kind: 'model.settled',
      requested: 'decision-request',
      settlement: { output: {} },
    },
    {
      ...base,
      id: 'decision',
      kind: 'decision.selected',
      requested: 'decision-request',
      phase: 'ACT',
      operation: 'write',
      confidence: 1,
    },
    {
      ...base,
      id: 'intended',
      kind: 'action.intended',
      decision: 'decision',
      intent: {
        id: 'unknown-intent',
        tool: 'write',
        arguments: { path: 'never-written.txt' },
        effectClass: 'workspace_mutation',
        environmentEpoch: 'epoch',
        toolRevision: '1',
      },
    },
    { ...base, id: 'dispatch', kind: 'action.dispatching', intentId: 'unknown-intent', epoch: 'epoch' },
    {
      ...base,
      id: 'settlement',
      kind: 'action.settled',
      intentId: 'unknown-intent',
      effect: 'unknown',
      outcome: {
        kind: 'error',
        content: [],
        error: { code: 'UNCERTAIN', message: 'Committed external state uncertain' },
        directive: { conclude: false, additions: [] },
      },
      observations: [],
    },
    {
      ...base,
      id: 'stop',
      kind: 'run.stopped',
      reason: 'blocked',
      detail: 'Original unknown outcome',
      unresolved: ['unknown-intent'],
    },
  ]
  await seed.d.log.append(prefix.map((record) => seed.ev('runtime/record', { runtime: identity, record })))
  await first.close()
  const activeClient = client()
  const sdk = await activeClient.session.load(created.id, { cwd: root })
  const session = live()
  // Exercise the production proxy and actual worker dispatcher in process. Only the private channel
  // transport is replaced; the endpoint, Core, Jev driver and persistent ledger remain real.
  const control = session.controlRuntime.bind(session)
  const workerSession = Object.create(session) as HostSession
  workerSession.controlRuntime = control
  const channel = {
    alive: true,
    command: (method: Parameters<WorkerSessionChannel['command']>[0], params: Record<string, unknown>) =>
      handleCommand(
        workerSession,
        { kind: 'command', requestId: 'control', sessionKey: session.key, method, params },
        { host, aborts: new Map() },
      ),
  } as WorkerSessionChannel
  const remote = new RemoteSession(session.key, 'fixture-writer', 1, channel, root, undefined, identity)
  session.controlRuntime = (value) => remote.controlRuntime(value)
  return {
    root,
    host,
    client,
    activeClient,
    sdk,
    session,
    control,
    provider,
    invoke,
    async reopen() {
      await activeClient.close()
      const next = client()
      await next.session.load(created.id, { cwd: root })
      return { client: next, session: live() }
    },
    async close() {
      for (const value of clients) await value.close()
      await host.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

it.each(['confirmed_applied', 'confirmed_not_applied', 'accepted_uncertainty'])(
  'routes owner-authorized SDK %s controls through worker/Core to one persistent resolution without executing work',
  async (resolution) => {
    const t = await fixture()
    try {
      await expect(t.sdk.runtime()).resolves.toMatchObject({ runtime: identity, phase: 'parked' })
      const before = t.session.lastSeq
      await expect(
        t.sdk.controlRuntime({ ...input, expectedRuntime: { id: 'native', version: '1' } }),
      ).rejects.toMatchObject({ data: { code: 'RUNTIME_IDENTITY_MISMATCH' } })
      await expect(t.sdk.controlRuntime({ ...input, operation: 'unknown' })).rejects.toMatchObject({
        data: { code: 'RUNTIME_CONTROL_UNSUPPORTED' },
      })
      for (const payload of [
        null,
        {},
        { ...(input.payload as object), explanation: ' ' },
        { ...(input.payload as object), evidence: [] },
        { ...(input.payload as object), evidence: [' '] },
        { ...(input.payload as object), extra: true },
        { ...(input.payload as object), resolution: 'retry' },
      ])
        await expect(t.sdk.controlRuntime({ ...input, payload })).rejects.toMatchObject({
          data: { code: 'RUNTIME_CONTROL_INVALID' },
        })
      const stranger = t.client('foreign-owner')
      await expect(
        stranger.call('_agnes/v1/session.runtimeControl', { ...input, sessionId: t.sdk.id }),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      expect(t.session.lastSeq).toBe(before)
      const running = t.session.run({ until: 'turn-end', signal: new AbortController().signal })
      await expect(t.control({ ...input, actor })).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
      await running
      const result = await t.sdk.controlRuntime({
        ...input,
        payload: { ...(input.payload as object), resolution },
      })
      expect(result).toEqual({
        runtime: identity,
        result: { intentId: 'unknown-intent', resolution },
        effectiveFromSeq: t.session.lastSeq,
      })
      await expect(t.sdk.runtime()).resolves.toMatchObject({ runtime: identity, phase: 'idle' })
      const projected = (await records(t.session)).map((entry) => entry.record)
      expect(projected.at(-1)).toMatchObject({
        kind: 'action.resolved',
        resolution,
        actor: 'local/local',
        explanation: 'Operator inspected disk',
        evidence: ['recorded receipt'],
      })
      expect(projected.findLast((record) => record.kind === 'run.stopped')).toMatchObject({
        reason: 'blocked',
        unresolved: ['unknown-intent'],
      })
      await expect(t.sdk.controlRuntime(input)).rejects.toMatchObject({
        data: { code: 'RUNTIME_CONTROL_INVALID' },
      })
      expect(t.provider.calls).toHaveLength(0)
      expect(t.invoke).not.toHaveBeenCalled()
      const reopened = await t.reopen()
      expect(
        (await records(reopened.session)).filter((entry) => entry.record.kind === 'action.resolved'),
      ).toHaveLength(1)
      const loaded = await reopened.client.session.attach(t.sdk.id)
      await expect(loaded.runtime()).resolves.toMatchObject({ runtime: identity, phase: 'idle' })
      await expect(loaded.controlRuntime(input)).rejects.toMatchObject({
        data: { code: 'RUNTIME_CONTROL_INVALID' },
      })
      const native = await reopened.client.session.new({
        cwd: t.root,
        sessionKey: 'native-control',
        runtime: 'native',
      })
      await expect(
        native.controlRuntime({ ...input, expectedRuntime: { id: 'native', version: '1' } }),
      ).rejects.toMatchObject({ data: { code: 'RUNTIME_CONTROL_UNSUPPORTED' } })
    } finally {
      await t.close()
    }
  },
)

it.each(['before', 'after'])(
  'refuses a failed resolution commit %s storage acknowledgement and restores only the committed prefix',
  async (when) => {
    const t = await fixture()
    try {
      await t.session.enqueue('next-turn', {
        actor,
        content: [{ type: 'text', text: 'Queued followup must not run' }],
      })
      const append = t.session.d.log.append.bind(t.session.d.log)
      const fail = vi.spyOn(t.session.d.log, 'append').mockImplementation(async (events) => {
        if (
          events.some(
            (event) =>
              event.type === 'runtime/record' &&
              (event.data as { record: { kind: string } }).record.kind === 'action.resolved',
          )
        ) {
          if (when === 'after') await append(events)
          throw new Error('Synthetic resolution acknowledgement failure')
        }
        return append(events)
      })
      await expect(t.sdk.controlRuntime(input)).rejects.toMatchObject({ data: { code: 'INTERNAL' } })
      fail.mockRestore()
      expect(t.provider.calls).toHaveLength(0)
      expect(t.invoke).not.toHaveBeenCalled()
      expect(await t.session.scan({ type: 'turn/start', toSeq: t.session.lastSeq, limit: 1000 })).toEqual([])
      const reopened = await t.reopen()
      expect(
        (await records(reopened.session)).filter((entry) => entry.record.kind === 'action.resolved'),
      ).toHaveLength(when === 'before' ? 0 : 1)
      const loaded = await reopened.client.session.attach(t.sdk.id)
      if (when === 'before')
        await expect(loaded.controlRuntime(input)).resolves.toMatchObject({
          result: { resolution: 'accepted_uncertainty' },
        })
      else
        await expect(loaded.controlRuntime(input)).rejects.toMatchObject({
          data: { code: 'RUNTIME_CONTROL_INVALID' },
        })
      expect(t.invoke).not.toHaveBeenCalled()
      expect(t.provider.calls).toHaveLength(0)
    } finally {
      await t.close()
    }
  },
)

it('holds maintenance through commit against duplicate controls, accepted prompts and closing', async () => {
  const t = await fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const committing = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    // Input acceptance predates control: it must not be drained merely by resolving UNKNOWN.
    await t.session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Accepted followup' }] })
    const append = t.session.d.log.append.bind(t.session.d.log)
    vi.spyOn(t.session.d.log, 'append').mockImplementation(async (events) => {
      if (
        events.some(
          (event) =>
            event.type === 'runtime/record' &&
            (event.data as { record: { kind: string } }).record.kind === 'action.resolved',
        )
      ) {
        entered()
        await gate
      }
      return append(events)
    })
    const control = t.sdk.controlRuntime(input)
    await committing
    await expect(t.sdk.controlRuntime(input)).rejects.toMatchObject({ data: { code: 'RUNTIME_BUSY' } })
    await expect(
      t.session.run({ until: 'turn-end', signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
    let accepted!: () => void
    const promptEntered = new Promise<void>((resolve) => {
      accepted = resolve
    })
    const enqueue = t.session.enqueue.bind(t.session)
    vi.spyOn(t.session, 'enqueue').mockImplementation((...args) => {
      accepted()
      return enqueue(...args)
    })
    const prompt = t.sdk.prompt('Concurrent explicit prompt').then(
      () => null,
      (error: unknown) => error,
    )
    await promptEntered
    expect(await t.session.scan({ type: 'turn/start', toSeq: t.session.lastSeq, limit: 1000 })).toEqual([])
    expect(t.invoke).not.toHaveBeenCalled()
    let closed = false
    const closing = t.session.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await expect(control).resolves.toMatchObject({ result: { intentId: 'unknown-intent' } })
    await closing
    expect(await prompt).toBeInstanceOf(Error)
    const reopened = await t.reopen()
    expect(
      (await records(reopened.session)).filter((entry) => entry.record.kind === 'action.resolved'),
    ).toHaveLength(1)
    expect(
      await reopened.session.scan({ type: 'turn/start', toSeq: reopened.session.lastSeq, limit: 1000 }),
    ).toEqual([])
    expect(t.invoke).not.toHaveBeenCalled()
    expect(t.provider.calls).toHaveLength(0)
  } finally {
    release()
    await t.close()
  }
})

it('distinguishes a restored unfinished turn from ordinary idle without running or appending recovery work', async () => {
  const t = await fixture()
  try {
    const sdk = await t.activeClient.session.new({
      cwd: t.root,
      sessionKey: 'interrupted-control',
      runtime: 'jevloop',
    })
    await expect(sdk.runtime()).resolves.toMatchObject({ phase: 'idle' })
    const session = t.host.kernel.get(sdk.id)
    if (!session) throw new Error('Fixture session is not open')
    await session.d.log.append([session.ev('turn/start', { turn: 1, trigger: 'prompt' })])
    const prefix = await session.scan({ toSeq: session.lastSeq, limit: 1000 })
    await session.close()
    const restored = await t.host.createSession({ key: sdk.id, cwd: t.root })
    expect(restored.runtimeState()).toMatchObject({ runtime: identity, phase: 'recovering' })
    expect(await restored.scan({ toSeq: restored.lastSeq, limit: 1000 })).toEqual(prefix)
    expect(t.invoke).not.toHaveBeenCalled()
    expect(t.provider.calls).toHaveLength(0)
  } finally {
    await t.close()
  }
})
