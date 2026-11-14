import { createHash } from 'node:crypto'
import type { ManagedSessionStartInput } from '@agnes/extension-api'
import { grantKey } from '@agnes/plugin-runtime/host'
import { rpcError } from '@agnes/protocol'
import { JsonRpcError, TransportClosed } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { HostInputResolution, OwnerInputEngine } from '../src/supervisor/managed-input-admission.js'
import { createIdleSignal, driveOwnerInputs } from '../src/supervisor/managed-session-idle.js'
import { ManagedSessionInputs } from '../src/supervisor/managed-session-inputs.js'
import { ManagedSessionRecords } from '../src/supervisor/managed-session-records.js'
import {
  createManagedSessions,
  type ManagedSessionCaller,
  type ManagedSessionPorts,
} from '../src/supervisor/managed-sessions.js'
import {
  managedWorkspaceGrants,
  pruneOrphanGrants,
  releaseManagedSessions,
} from '../src/supervisor/managed-workspace-grants.js'
import { createSupervisorProfileServices } from '../src/supervisor/profile-services.js'
import { caller, fakeCore, memoryTable, owner, receipt } from './fixtures/fake-input-ports.js'

const denied = { data: { code: 'CAPABILITY_DENIED' } }
const refused = (reason: string) => ({ data: { code: 'CAPABILITY_DENIED', reason } })
const other: ManagedSessionCaller = {
  ...caller,
  owner: 'plugin/fedcba9876543210',
  packageId: '@example/other',
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** `taskBinding: undefined` starts an unbound session, as a plugin before task bindings did. */
const start = (
  over: { [K in keyof ManagedSessionStartInput]?: ManagedSessionStartInput[K] | undefined } = {},
) => {
  const input: Record<string, unknown> = {
    bundle: '@example/companion#worker',
    workspace: '/work/repo',
    input: 'Fix the failing test.',
    startKey: 'task-1:0',
    retention: 'task',
    taskBinding: { id: 'task-1', generation: 0 },
    ...over,
  }
  for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key]
  return input as unknown as ManagedSessionStartInput
}
const admission = (key: string, receiptId = key, target: Record<string, unknown> = {}) => ({
  key,
  target: { taskId: 'task-1', taskGeneration: 0, startKey: 'task-1:0', ...target },
  input: { kind: 'ownerMessage' as const, receiptId },
})

function world() {
  const table = memoryTable()
  const records = new ManagedSessionRecords(table)
  const inputs = new ManagedSessionInputs(table)
  const core = fakeCore()
  const authorized = new Set([caller.owner, other.owner])
  const enabled = new Set([owner, grantKey(other.packageId, other.owner)])
  const started: string[] = []
  const ports: ManagedSessionPorts = {
    async authorize(c) {
      if (!authorized.has(c.owner)) throw Object.assign(new Error('CAPABILITY_DENIED'), denied)
    },
    records,
    forkParent: () => undefined,
    workspaceRoot: async (path) => path,
    resolveAgent: async () => undefined,
    models: async () => [],
    autoReview: async () => false,
    fullAccess: async () => ({ outwardCheckpoint: true, osBoundary: false }),
    sessions: {
      ...core.ports,
      create: async (input) => input.sessionKey,
      setModel: async () => undefined,
      setFullAccess: async () => undefined,
      policy: async () => ({ fullAccess: false, osBoundary: false, outwardCheckpoint: true }),
      async submit(sessionId, input) {
        if (core.state.running.has(sessionId)) return 'busy'
        started.push(`${sessionId}:${input.text}`)
        return 'started'
      },
      loaded: () => true,
      view: async () => ({ timeline: { turns: [], nodes: [] } }) as never,
      toolDetail: async () => ({ call: { name: 'x' } }),
      ownerApprover: async () => undefined,
      cancel: async () => undefined,
      archive: async (sessionId) => void core.state.archived.add(sessionId),
    },
  }
  for (const key of enabled) records.grant(key, '/work/repo')
  const sessions = createManagedSessions(ports, {
    inputs,
    enabled: async (rowOwner) => enabled.has(rowOwner),
  })
  /** The Host resolves the receipt the admission names; `r1` unless told otherwise. */
  const port = (c: ManagedSessionCaller = caller, receiptId = 'r1') =>
    sessions(c, { resolution: receipt(receiptId) })
  return { table, records, inputs, core, authorized, enabled, started, sessions, port, ports }
}

describe('managed sessions bound to a task', () => {
  it('start with taskBinding writes the binding with the record', async () => {
    const w = world()
    const { sessionId } = await w.port().start(start())
    expect(w.records.binding(sessionId)).toEqual({
      sessionId,
      taskId: 'task-1',
      taskGeneration: 0,
      inputDigest: digest('Fix the failing test.'),
    })
    await expect(w.port().start(start({ taskBinding: { id: '', generation: 0 } }))).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
  })

  it('start repeat with another binding or another first input throws START_KEY_REUSED; unbound sessions keep the old comparison', async () => {
    const w = world()
    const first = await w.port().start(start())
    for (const over of [
      { taskBinding: { id: 'task-1', generation: 1 } },
      { taskBinding: { id: 'task-2', generation: 0 } },
      { input: 'Something else.' },
      { taskBinding: undefined },
    ] as Parameters<typeof start>[0][])
      await expect(w.port().start(start(over))).rejects.toMatchObject(refused('START_KEY_REUSED'))
    expect(await w.port().start(start())).toEqual({ sessionId: first.sessionId, created: false })
    const unbound = await w.port().start(start({ startKey: 'plain', taskBinding: undefined }))
    expect(
      await w.port().start(start({ startKey: 'plain', taskBinding: undefined, input: 'Other words.' })),
    ).toEqual({
      sessionId: unbound.sessionId,
      created: false,
    })
    expect(w.records.binding(unbound.sessionId)).toBeUndefined()
  })

  it('start with taskBinding on an existing unbound record late-binds with a null input digest instead of refusing', async () => {
    const w = world()
    const unbound = await w.port().start(start({ taskBinding: undefined }))
    expect(await w.port().start(start({ input: 'A later first input.' }))).toEqual({
      sessionId: unbound.sessionId,
      created: false,
    })
    expect(w.records.binding(unbound.sessionId)).toMatchObject({ taskId: 'task-1', inputDigest: null })
    await expect(
      w.port().start(start({ taskBinding: { id: 'task-9', generation: 0 } })),
    ).rejects.toMatchObject(refused('START_KEY_REUSED'))
  })

  it('send on a bound session throws OWNER_INPUT_REQUIRED before archived, duplicate and busy', async () => {
    const w = world()
    const { sessionId } = await w.port().start(start())
    const send = () => w.port().send(sessionId, { text: 'more', idempotencyKey: 'k1' })
    await expect(send()).rejects.toMatchObject(refused('OWNER_INPUT_REQUIRED'))
    w.records.setSend(owner, sessionId, 'k1', 'sent')
    w.core.state.running.add(sessionId)
    await w.port().archive(sessionId)
    await expect(send()).rejects.toMatchObject(refused('OWNER_INPUT_REQUIRED'))
    const plain = await w.port().start(start({ startKey: 'plain', taskBinding: undefined }))
    expect(await w.port().send(plain.sessionId, { text: 'more', idempotencyKey: 'k1' })).toEqual({
      state: 'started',
    })
  })

  it('pre-upgrade session late-binds once on first admission; a later target naming another task throws OWNER_INPUT_TARGET_MISMATCH', async () => {
    const w = world()
    const { sessionId } = await w.port().start(start({ taskBinding: undefined }))
    expect(await w.port().inputResult(sessionId, { key: 'k1' })).toEqual({
      state: 'absent',
      historyCoverage: 'complete',
    })
    expect(w.records.binding(sessionId)).toBeUndefined()
    expect(await w.port().admitInput(sessionId, admission('k1', 'r1'))).toMatchObject({ state: 'enqueued' })
    expect(w.records.binding(sessionId)).toEqual({
      sessionId,
      taskId: 'task-1',
      taskGeneration: 0,
      inputDigest: null,
    })
    await expect(
      w.port().admitInput(sessionId, admission('k2', 'r1', { taskId: 'task-2' })),
    ).rejects.toMatchObject(refused('OWNER_INPUT_TARGET_MISMATCH'))
    await expect(
      w.port().admitInput(sessionId, admission('k3', 'r1', { taskGeneration: 1 })),
    ).rejects.toMatchObject(refused('OWNER_INPUT_TARGET_MISMATCH'))
    expect(w.records.binding(sessionId)).toMatchObject({ taskId: 'task-1', taskGeneration: 0 })
    await expect(w.port().send(sessionId, { text: 'x', idempotencyKey: 'k9' })).rejects.toMatchObject(
      refused('OWNER_INPUT_REQUIRED'),
    )
  })

  it("late binding needs the session's own start key and its own manager", async () => {
    const w = world()
    const { sessionId } = await w.port().start(start({ taskBinding: undefined }))
    await expect(
      w.port().admitInput(sessionId, admission('k1', 'r1', { startKey: 'another' })),
    ).rejects.toMatchObject(refused('OWNER_INPUT_TARGET_MISMATCH'))
    await expect(w.port(other).admitInput(sessionId, admission('k1'))).rejects.toMatchObject(denied)
    expect(w.records.binding(sessionId)).toBeUndefined()
    expect(w.inputs.get(owner, sessionId, 'k1')).toBeUndefined()
  })

  it('admitInput and inputResult run authorize and own like every other action', async () => {
    const w = world()
    const { sessionId } = await w.port().start(start())
    w.authorized.delete(caller.owner)
    await expect(w.port().admitInput(sessionId, admission('k1', 'r1'))).rejects.toMatchObject(denied)
    await expect(w.port().inputResult(sessionId, { key: 'k1' })).rejects.toMatchObject(denied)
    await expect(w.port(other).admitInput(sessionId, admission('k1', 'r1'))).rejects.toMatchObject(denied)
    await expect(w.port(other).inputResult(sessionId, { key: 'k1' })).rejects.toMatchObject(denied)
    await expect(w.port(other).admitInput('unknown', admission('k1', 'r1'))).rejects.toMatchObject(denied)
    expect(w.inputs.get(owner, sessionId, 'k1')).toBeUndefined()
    w.authorized.add(caller.owner)
    expect(await w.port().admitInput(sessionId, admission('k1', 'r1'))).toMatchObject({ state: 'enqueued' })
    expect(w.core.state.submits.map((s) => s.text)).toEqual(['text of r1'])
  })

  it('profile-services passes resolution only for admitInput and drops a malformed one', async () => {
    const services = createSupervisorProfileServices({
      runtime: undefined,
      profile: 'p',
      pool: {},
      repo: undefined,
      profileHash: 'h',
      clock: () => 0,
      ownership: { resolve: () => undefined },
      workspaces: {},
      registry: {},
    } as unknown as Parameters<typeof createSupervisorProfileServices>[0])
    const seen: unknown[] = []
    const record = (host: unknown) => async () => seen.push(host)
    services.managedSessions.port = (_c, host) =>
      ({ admitInput: record(host), inputResult: record(host), list: record(host) }) as never
    const lane = { sharedWorker: true, sessionKey: '@profile' }
    const call = (action: string, resolution: unknown) =>
      services.ownedSession(lane, { ...caller, action, args: ['s1', admission('k1')], resolution })
    const good = receipt('r1') as Extract<HostInputResolution, { kind: 'receipt' }>
    await call('admitInput', good)
    await call('admitInput', { ...good, source: { ...good.source, kind: 'other' } })
    await call('admitInput', { ...good, text: 'a\0b' })
    await call('admitInput', { kind: 'unresolved', receiptId: 'r1', reason: 'pairingChanged', text: 'x' })
    await call('inputResult', good)
    await call('list', good)
    expect(seen).toEqual([
      { resolution: good },
      { resolution: undefined },
      { resolution: undefined },
      { resolution: { kind: 'unresolved', receiptId: 'r1', reason: 'pairingChanged' } },
      undefined,
      undefined,
    ])
  })

  it('revokeAll, revoke and releasePackage withdraw owner inputs before the grants go', async () => {
    const w = world()
    const engine = w.sessions.engine as OwnerInputEngine
    const queued = async (startKey: string) => {
      const { sessionId } = await w
        .port()
        .start(start({ startKey, taskBinding: { id: startKey, generation: 0 } }))
      await w
        .port(caller, `${startKey}-r`)
        .admitInput(sessionId, admission('k1', `${startKey}-r`, { taskId: startKey, startKey }))
      expect(w.core.state.inbox.get(sessionId)).toHaveLength(1)
      return sessionId
    }
    const pkg = { packageId: caller.packageId, sessions: true, owners: new Set([caller.owner]) }
    const otherPkg = { packageId: other.packageId, sessions: true, owners: new Set([other.owner]) }
    const order: string[] = []
    const withdraw = async (rowOwner: string, workspace?: string) => {
      order.push(`withdraw granted=${w.records.granted(rowOwner, '/work/repo')}`)
      await engine.withdraw(rowOwner, workspace)
    }

    const revoked = await queued('a')
    const grants = managedWorkspaceGrants({
      records: w.records,
      packages: async () => [pkg, otherPkg],
      workspaceRoot: async (path) => path,
      canonical: async (path) => path,
      withdraw,
    })
    await grants.revoke(caller.packageId, '/work/repo')
    expect(order).toEqual(['withdraw granted=true'])
    expect(w.core.state.inbox.get(revoked)).toEqual([])
    expect(w.inputs.get(owner, revoked, 'k1')).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })

    w.records.grant(owner, '/work/repo')
    const pruned = await queued('b')
    order.length = 0
    await pruneOrphanGrants(w.records, async () => [otherPkg], withdraw)
    expect(order).toEqual(['withdraw granted=true'])
    expect(w.records.granted(owner, '/work/repo')).toBe(false)
    expect(w.core.state.inbox.get(pruned)).toEqual([])

    w.records.grant(owner, '/work/repo')
    const released = await queued('c')
    await releaseManagedSessions({ records: w.records, inputs: w.inputs, engine }, caller.packageId)
    expect(w.core.state.inbox.get(released)).toEqual([])
    expect(w.inputs.get(owner, released, 'k1')).toBeUndefined()
    expect(w.records.granted(owner, '/work/repo')).toBe(false)
    expect(w.core.ran(released, 'text of c-r')).toBe(0)
  })

  it('a grant pruned before the engine is set is withdrawn at the first sweep and never runs', async () => {
    const w = world()
    const engine = w.sessions.engine as OwnerInputEngine
    const { sessionId } = await w.port().start(start())
    await w.port().admitInput(sessionId, admission('k1', 'r1'))
    // Boot recovery prunes the grant while the holder has no engine yet: nothing is withdrawn.
    const otherPkg = { packageId: other.packageId, sessions: true, owners: new Set([other.owner]) }
    await pruneOrphanGrants(w.records, async () => [otherPkg])
    expect(w.core.state.inbox.get(sessionId)).toHaveLength(1)
    await engine.sweep()
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({
      state: 'needsOwner',
      reason: 'grantRevoked',
    })
    expect(w.core.state.inbox.get(sessionId)).toEqual([])
    expect(w.core.take(sessionId)).toBeUndefined()
    expect(w.core.ran(sessionId, 'text of r1')).toBe(0)
  })

  it('a disabled package whose grant was pruned before the engine is set has its input withdrawn at the first sweep', async () => {
    const w = world()
    const engine = w.sessions.engine as OwnerInputEngine
    const { sessionId } = await w.port().start(start())
    await w.port().admitInput(sessionId, admission('k1', 'r1'))
    expect(w.core.state.inbox.get(sessionId)).toHaveLength(1)
    // The package is switched off, then boot recovery prunes its grant while the holder has no engine.
    w.enabled.delete(owner)
    const otherPkg = { packageId: other.packageId, sessions: true, owners: new Set([other.owner]) }
    await pruneOrphanGrants(w.records, async () => [otherPkg])
    expect(w.records.granted(owner, '/work/repo')).toBe(false)
    await engine.sweep()
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({
      state: 'needsOwner',
      reason: 'grantRevoked',
      submittedSeq: null,
    })
    expect(w.core.state.inbox.get(sessionId)).toEqual([])
    expect(w.core.take(sessionId)).toBeUndefined()
    expect(w.core.ran(sessionId, 'text of r1')).toBe(0)
  })

  it('a package released before the engine is set keeps its submitted inputs until the first sweep withdraws and deletes them', async () => {
    const w = world()
    const engine = w.sessions.engine as OwnerInputEngine
    const { sessionId } = await w.port().start(start())
    await w.port().admitInput(sessionId, admission('k1', 'r1'))
    w.core.state.running.add(sessionId)
    await w.port(caller, 'r2').admitInput(sessionId, admission('k2', 'r2'))
    w.core.state.running.delete(sessionId)
    await releaseManagedSessions({ records: w.records, inputs: w.inputs }, caller.packageId)
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({ state: 'enqueued' })
    expect(w.inputs.get(owner, sessionId, 'k2')).toBeUndefined()
    expect(w.records.granted(owner, '/work/repo')).toBe(false)
    // The owner still runs the detached session in the Web; its idle report neither takes back nor drops the row.
    await engine.advance(sessionId)
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({ state: 'enqueued' })
    await engine.sweep()
    expect(w.core.state.withdrawals.map((entry) => entry.sessionId)).toEqual([sessionId])
    expect(w.core.state.inbox.get(sessionId)).toEqual([])
    expect(w.inputs.get(owner, sessionId, 'k1')).toBeUndefined()
    expect(w.inputs.sessionsWithWork()).toEqual([])
    expect(w.core.take(sessionId)).toBeUndefined()
    expect(w.core.ran(sessionId, 'text of r1')).toBe(0)
  })

  it('archive withdraws a confirmed queued input at once', async () => {
    const w = world()
    const { sessionId } = await w.port().start(start())
    await w.port().admitInput(sessionId, admission('k1', 'r1'))
    expect(w.core.state.inbox.get(sessionId)).toHaveLength(1)
    await w.port().archive(sessionId)
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({
      state: 'retained',
      reason: 'sessionArchived',
    })
    expect(w.core.state.inbox.get(sessionId)).toEqual([])
    expect(w.core.ran(sessionId, 'text of r1')).toBe(0)
  })

  it('onIdle, startup and the slow sweep reach the engine', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const idle = createIdleSignal()
      const calls: string[] = []
      const engine = {
        advance: async (sessionId: string) => void calls.push(`advance ${sessionId}`),
        sweep: async () => void calls.push('sweep'),
      }
      const drive = driveOwnerInputs(idle, engine, 60_000)
      const tick = () => new Promise((resolve) => setImmediate(resolve))
      idle.notify('s1')
      await tick()
      expect(calls).toEqual(['advance s1'])
      idle.started()
      await tick()
      expect(calls).toEqual(['advance s1', 'sweep'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toEqual(['advance s1', 'sweep', 'sweep'])
      drive.dispose()
      idle.notify('s2')
      await vi.advanceTimersByTimeAsync(60_000)
      await tick()
      expect(calls).toEqual(['advance s1', 'sweep', 'sweep'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('once shutdown starts, neither an idle report already scheduled nor a sweep reaches the engine', async () => {
    const idle = createIdleSignal()
    const calls: string[] = []
    const engine = {
      advance: async (sessionId: string) => void calls.push(`advance ${sessionId}`),
      sweep: async () => void calls.push('sweep'),
      close: () => void calls.push('close'),
    }
    const drive = driveOwnerInputs(idle, engine, 60_000)
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    // The turn ends as shutdown begins: its idle report is scheduled, then the drive stops.
    idle.notify('s1')
    drive.stop()
    idle.started()
    await tick()
    await tick()
    expect(calls).toEqual(['close'])
  })

  it('a closed engine neither advances nor sweeps, and a sweep under way stops before the next session', async () => {
    const w = world()
    const engine = w.sessions.engine as OwnerInputEngine
    const a = await w.port().start(start())
    const b = await w.port().start(start({ startKey: 'task-1:b', taskBinding: undefined }))
    for (const [sessionId, key] of [
      [a.sessionId, 'k1'],
      [b.sessionId, 'k2'],
    ] as const) {
      w.core.state.running.add(sessionId)
      await w
        .port(caller, key)
        .admitInput(sessionId, admission(key, key, sessionId === b.sessionId ? { startKey: 'task-1:b' } : {}))
      w.core.state.running.delete(sessionId)
    }
    // Shutdown starts while the sweep works on the first session.
    const activity = w.ports.sessions.activity
    w.ports.sessions.activity = async () => {
      engine.close()
      return activity()
    }
    await engine.sweep()
    expect(w.core.state.submits.map((entry) => entry.text)).toEqual(['text of k1'])
    w.ports.sessions.activity = activity
    await engine.advance(b.sessionId)
    await engine.sweep()
    expect(w.core.state.submits.map((entry) => entry.text)).toEqual(['text of k1'])
    expect(w.inputs.get(owner, b.sessionId, 'k2')).toMatchObject({ state: 'enqueued', reason: 'busy' })
  })

  it('held inputs are not submitted while the plugin is disabled, and are submitted after it is enabled again', async () => {
    const w = world()
    const { sessionId } = await w.port().start(start())
    w.core.state.running.add(sessionId)
    expect(await w.port().admitInput(sessionId, admission('k1', 'r1'))).toMatchObject({ reason: 'busy' })
    w.core.state.running.delete(sessionId)
    w.enabled.delete(owner)
    const engine = w.sessions.engine as OwnerInputEngine
    await engine.advance(sessionId)
    await engine.sweep()
    expect(w.core.state.submits).toEqual([])
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({
      state: 'enqueued',
      reason: 'busy',
      version: 2,
    })
    w.enabled.add(owner)
    await engine.sweep()
    expect(w.core.state.submits.map((s) => s.text)).toEqual(['text of r1'])
  })

  it('a sweep does not start a confirmed queued input while its package is disabled', async () => {
    const w = world()
    const engine = w.sessions.engine as OwnerInputEngine
    const { sessionId } = await w.port().start(start())
    await w.port().admitInput(sessionId, admission('k1', 'r1'))
    expect(w.core.state.inbox.get(sessionId)).toHaveLength(1)
    const submits = w.core.state.submits.length
    w.enabled.delete(owner)
    await engine.sweep()
    await engine.sweep()
    // Paused: left in the inbox, neither re-kicked nor taken back, and the row is unchanged.
    expect(w.core.state.submits).toHaveLength(submits)
    expect(w.core.state.withdrawals).toEqual([])
    expect(w.core.state.inbox.get(sessionId)).toHaveLength(1)
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({ state: 'enqueued', reason: 'eligible' })
    // Enabled again, the next sweep re-kicks it once under the same id.
    w.enabled.add(owner)
    await engine.sweep()
    expect(w.core.state.submits.slice(submits)).toEqual([
      expect.objectContaining({ commandId: w.core.state.submits[0]?.commandId, dedupe: true }),
    ])
  })

  it('a gate that cannot be read keeps the input held; only a refused gate gives it to the owner', async () => {
    const w = world()
    const engine = w.sessions.engine as OwnerInputEngine
    const { sessionId } = await w.port().start(start())
    const policy = w.ports.sessions.policy
    const unreadable = async () => {
      throw new Error('transport closed')
    }
    // A held input while the daemon shuts down: the turn ends, but the live policy cannot be read.
    w.core.state.running.add(sessionId)
    expect(await w.port().admitInput(sessionId, admission('k1', 'r1'))).toMatchObject({ reason: 'busy' })
    w.core.state.running.delete(sessionId)
    w.ports.sessions.policy = unreadable
    await engine.advance(sessionId)
    await engine.sweep()
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({
      state: 'enqueued',
      reason: 'busy',
      version: 2,
    })
    expect(w.core.state.submits).toEqual([])
    // An admission whose gates cannot be read is not answered; the key stays queued for the retry.
    await expect(w.port(caller, 'r2').admitInput(sessionId, admission('k2', 'r2'))).rejects.toThrow(
      'transport closed',
    )
    expect(w.inputs.get(owner, sessionId, 'k2')).toMatchObject({ state: 'queued' })
    // Readable again: the held input runs, and the retried admission completes.
    w.ports.sessions.policy = policy
    await engine.sweep()
    expect(w.core.state.submits.map((entry) => entry.text)).toEqual(['text of r1'])
    expect(await w.port(caller, 'r2').admitInput(sessionId, admission('k2', 'r2'))).toMatchObject({
      state: 'enqueued',
    })
    // A gate that refuses still gives the input to the owner.
    w.ports.sessions.policy = async () => ({ fullAccess: false, osBoundary: false, outwardCheckpoint: false })
    w.core.state.running.add(sessionId)
    await w.port(caller, 'r3').admitInput(sessionId, admission('k3', 'r3'))
    expect(w.inputs.get(owner, sessionId, 'k3')).toMatchObject({
      state: 'needsOwner',
      reason: 'grantRevoked',
    })
  })

  it('a shared worker that cannot answer the bundle check keeps a held input held; after a restart it runs once', async () => {
    const w = world()
    const engine = w.sessions.engine as OwnerInputEngine
    const { sessionId } = await w.port().start(start())
    w.core.state.running.add(sessionId)
    expect(await w.port().admitInput(sessionId, admission('k1', 'r1'))).toMatchObject({ reason: 'busy' })
    w.core.state.running.delete(sessionId)
    const resolveAgent = w.ports.resolveAgent
    // The daemon's link to the shared worker closed or timed out, the worker could not be started or
    // failed without an answer, or a client transport closed: none says anything about the bundle.
    for (const failure of [
      new Error('worker link closed'),
      new Error('worker command agents.resolve timed out'),
      { code: 'E_WORKER', message: 'Worker operation failed.' },
      new TransportClosed({ reason: 'eof' }),
      new JsonRpcError(rpcError('INTERNAL_ERROR', { code: 'INTERNAL' })),
    ]) {
      w.ports.resolveAgent = async () => {
        throw failure
      }
      await engine.advance(sessionId)
      await engine.sweep()
      expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({ state: 'enqueued', reason: 'busy' })
    }
    expect(w.core.state.submits).toEqual([])
    // A restart: a new engine over the same tables, with the shared worker answering again.
    w.ports.resolveAgent = resolveAgent
    const restarted = createManagedSessions(w.ports, { inputs: new ManagedSessionInputs(w.table) })
    await restarted.engine?.sweep()
    w.core.take(sessionId)
    await restarted.engine?.sweep()
    await restarted.engine?.sweep()
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({ state: 'consumed' })
    expect(w.core.ran(sessionId, 'text of r1')).toBe(1)
    // A bundle the worker refuses on purpose (unknown, or not installed, enabled and trusted) still
    // gives the input to the owner.
    w.core.state.running.add(sessionId)
    for (const [key, refusal] of [
      ['k2', { code: 'E_PRESET_UNSUPPORTED', message: 'agent: unknown agent' }],
      ['k3', rpcError('SEMANTIC_REJECTED', { code: 'BUNDLE_UNAVAILABLE' })],
    ] as const) {
      w.ports.resolveAgent = async () => {
        throw refusal
      }
      await w.port(caller, key).admitInput(sessionId, admission(key, key))
      expect(w.inputs.get(owner, sessionId, key)).toMatchObject({
        state: 'needsOwner',
        reason: 'grantRevoked',
      })
    }
  })

  it('archiving a session retains its held inputs', async () => {
    const w = world()
    const { sessionId } = await w.port().start(start())
    w.core.state.running.add(sessionId)
    await w.port().admitInput(sessionId, admission('k1', 'r1'))
    await w.port().archive(sessionId)
    expect(w.inputs.get(owner, sessionId, 'k1')).toMatchObject({
      state: 'retained',
      reason: 'sessionArchived',
    })
  })
})
