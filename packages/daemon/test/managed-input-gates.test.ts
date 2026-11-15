import { rpcError } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { GatePending, gateReport, type LivePolicy } from '../src/supervisor/managed-input-gates.js'
import type { OwnerInputTrace } from '../src/supervisor/managed-input-trace.js'
import { ManagedSessionInputs } from '../src/supervisor/managed-session-inputs.js'
import {
  livePolicy,
  managedSessionPorts,
  readOutwardCheckpoint,
} from '../src/supervisor/managed-session-ports.js'
import { ManagedSessionRecords } from '../src/supervisor/managed-session-records.js'
import { createManagedSessions, type ManagedSessionPorts } from '../src/supervisor/managed-sessions.js'
import { caller, fakeCore, memoryTable, owner, receipt } from './fixtures/fake-input-ports.js'

const refused = (reason: string) => ({ data: { code: 'CAPABILITY_DENIED', reason } })
const startOf = (startKey: string) => ({
  bundle: '@example/companion#worker',
  workspace: '/work/repo',
  input: 'Fix the failing test.',
  startKey,
  retention: 'task' as const,
  permission: 'full-access' as const,
})

describe('gateReport', () => {
  it('tells a pass, a refusal before folding, and a gate that cannot answer yet apart; a failed read is rethrown', () => {
    expect(gateReport({ stage: 'live', l1: 'full' })).toEqual({ verdict: 'pass', l1: 'full' })
    expect(
      gateReport({ stage: 'start', l1: 'unprobed' }, new GatePending('full-access', 'l1-unprobed')),
    ).toEqual({ verdict: 'pending', gate: 'full-access', code: 'l1-unprobed', l1: 'unprobed' })
    const denied = (reason: string, detail: Record<string, unknown> = {}) =>
      rpcError('CAPABILITY_DENIED', { reason, ...detail })
    expect(gateReport({ stage: 'start' }, denied('WORKSPACE_NOT_AUTHORIZED'))).toEqual({
      verdict: 'refused',
      gate: 'workspace',
      code: 'WORKSPACE_NOT_AUTHORIZED',
    })
    expect(
      gateReport(
        { stage: 'start', l1: 'unavailable' },
        denied('FULL_ACCESS_UNAVAILABLE', { missing: 'os-boundary' }),
      ),
    ).toEqual({
      verdict: 'refused',
      gate: 'full-access',
      code: 'FULL_ACCESS_UNAVAILABLE',
      missing: 'os-boundary',
      l1: 'unavailable',
    })
    const live = { fullAccess: true, osBoundary: false, outwardCheckpoint: true }
    expect(
      gateReport(
        { stage: 'live', l1: 'full', live },
        denied('FULL_ACCESS_UNAVAILABLE', { missing: 'os-boundary' }),
      ),
    ).toMatchObject({ verdict: 'refused', gate: 'live-policy', live })
    expect(gateReport({ stage: 'start' }, denied('BUNDLE_UNAVAILABLE'))).toMatchObject({ gate: 'bundle' })
    const lost = new Error('link closed')
    expect(() => gateReport({ stage: 'start' }, lost)).toThrow(lost)
  })
})

describe('the full-access gate before the sandbox probe ran', () => {
  const unavailable = async (): Promise<never> => {
    throw new Error('not used')
  }

  it('reads an unreadable or missing L1 report as unreadable, never as a boundary', async () => {
    const ports = (sandboxL1: () => Promise<string | undefined>) =>
      managedSessionPorts({
        socketPath: '',
        serverIdentity: { pid: 0, processStartId: '' },
        records: {} as never,
        authorize: async () => undefined,
        forkParent: () => undefined,
        workspaces: {} as never,
        models: async () => [],
        registry: { get: () => undefined, open: unavailable },
        commandQueue: {} as never,
        continueTurn: () => undefined,
        opensWithCommandRules: true,
        sandboxL1,
        preferences: { get: () => ({ archived: false }) },
        idle: { onIdle: () => () => undefined },
      }).ports.fullAccess()
    expect(await ports(async () => 'full')).toEqual({ outwardCheckpoint: true, osBoundary: true, l1: 'full' })
    expect(await ports(async () => 'unprobed')).toMatchObject({ osBoundary: false, l1: 'unprobed' })
    expect(await ports(async () => undefined)).toMatchObject({ osBoundary: false, l1: 'unreadable' })
    expect(await ports(unavailable)).toMatchObject({ osBoundary: false, l1: 'unreadable' })
  })

  /**
   * A full-access session over fake ports: `l1` is what the platform's sandbox report says, and
   * `probeOnOpen` makes opening a session (the running gate's policy read) complete the probe, as a
   * workspace binding does in the daemon's shared worker.
   */
  function world() {
    const table = memoryTable()
    const records = new ManagedSessionRecords(table)
    const inputs = new ManagedSessionInputs(table)
    const core = fakeCore()
    const state = {
      l1: 'full',
      probeOnOpen: true,
      live: true,
      opens: 0,
      readFails: false,
      autoReview: false,
      bundleRefused: false,
      workspace: undefined as Error | undefined,
      unread: undefined as LivePolicy['unread'],
    }
    const traces: OwnerInputTrace[] = []
    const warnings: string[] = []
    const ports: ManagedSessionPorts = {
      authorize: async () => undefined,
      records,
      forkParent: () => undefined,
      async workspaceRoot(path) {
        if (state.workspace) throw state.workspace
        return path
      },
      async resolveAgent() {
        // The shared worker's reply for a bundle it does not resolve.
        if (state.bundleRefused) throw { code: 'E_PRESET_UNSUPPORTED', message: 'agent: unknown agent' }
      },
      models: async () => [],
      autoReview: async () => state.autoReview,
      async fullAccess() {
        if (state.readFails) throw new Error('shared worker link closed')
        return { outwardCheckpoint: true, osBoundary: state.l1 === 'full', l1: state.l1 }
      },
      sessions: {
        ...core.ports,
        create: async (input) => input.sessionKey,
        setModel: async () => undefined,
        setFullAccess: async () => undefined,
        async policy() {
          state.opens++
          if (state.probeOnOpen && state.l1 === 'unprobed') state.l1 = 'full'
          if (state.unread)
            return { fullAccess: true, osBoundary: false, outwardCheckpoint: false, unread: state.unread }
          return { fullAccess: true, osBoundary: state.live, outwardCheckpoint: true }
        },
        submit: async (sessionId) => (core.state.running.has(sessionId) ? 'busy' : 'started'),
        loaded: () => true,
        view: async () => ({ timeline: { turns: [], nodes: [] } }) as never,
        toolDetail: unavailable,
        ownerApprover: async () => undefined,
        cancel: async () => undefined,
        archive: async (sessionId) => void core.state.archived.add(sessionId),
      },
    }
    records.grant(owner, '/work/repo')
    const sessions = createManagedSessions(ports, {
      inputs,
      enabled: async () => true,
      warn: (message) => warnings.push(message),
      debug: () => undefined,
      trace: (entry) => traces.push(entry),
    })
    const engine = sessions.engine as NonNullable<typeof sessions.engine>
    const port = (receiptId = 'r1') => sessions(caller, { resolution: receipt(receiptId) })
    const begin = async (bound = true) => {
      const { sessionId } = await port().start({
        bundle: '@example/companion#worker',
        workspace: '/work/repo',
        input: 'Fix the failing test.',
        startKey: bound ? 'task-1:0' : 'plain',
        retention: 'task',
        permission: 'full-access',
        ...(bound ? { taskBinding: { id: 'task-1', generation: 0 } } : {}),
      })
      return sessionId
    }
    const admit = (sessionId: string, key: string, receiptId = key) =>
      port(receiptId).admitInput(sessionId, {
        key,
        target: { taskId: 'task-1', taskGeneration: 0, startKey: 'task-1:0' },
        input: { kind: 'ownerMessage', receiptId },
      })
    /** A running session holds `key`, then the daemon restarts: nothing runs, and the probe has not run. */
    const heldAcrossRestart = async (key = 'k1') => {
      const sessionId = await begin()
      core.state.running.add(sessionId)
      expect(await admit(sessionId, key)).toMatchObject({ state: 'enqueued', reason: 'busy' })
      core.state.running.delete(sessionId)
      state.l1 = 'unprobed'
      return sessionId
    }
    const row = (sessionId: string, key = 'k1') => inputs.get(owner, sessionId, key)
    const of = (key: string) => traces.filter((entry) => entry.key === key)
    return {
      state,
      core,
      records,
      inputs,
      engine,
      port,
      traces,
      warnings,
      begin,
      admit,
      heldAcrossRestart,
      row,
      of,
    }
  }

  it('the startup sweep opens the session so the probe runs, then submits the original key once', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    await w.engine.sweep('startup')
    expect(w.row(sessionId)).toMatchObject({ state: 'enqueued', reason: 'eligible' })
    expect(w.row(sessionId)?.submittedSeq).toBeGreaterThan(0)
    expect(w.core.take(sessionId)?.text).toBe('text of k1')
    await w.engine.advance(sessionId)
    expect(w.row(sessionId)?.state).toBe('consumed')
    expect(w.core.ran(sessionId, 'text of k1')).toBe(1)
    const swept = w.of('k1').filter((entry) => entry.trigger === 'startup-sweep')
    expect(swept[0]?.gate).toMatchObject({ verdict: 'pass', reopenedAfter: 'unprobed', l1: 'full' })
    expect(w.of('k1').some((entry) => entry.to?.startsWith('needsOwner'))).toBe(false)
    expect(w.warnings).toEqual([])
  })

  it('a probe that still has not run holds the input unchanged, submits nothing, and lets the next pass submit it', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    w.state.probeOnOpen = false
    const before = w.row(sessionId)
    for (const pass of [() => w.engine.sweep('startup'), () => w.engine.advance(sessionId, 'result')])
      await pass()
    expect(w.row(sessionId)).toEqual(before)
    expect(w.core.state.submits).toEqual([])
    expect(w.engine.attention(10)).toEqual([{ input: before, held: 'gatesUnreadable' }])
    expect(w.warnings.join('\n')).toContain('full-access cannot answer yet (l1-unprobed)')
    const held = w.of('k1').filter((entry) => entry.event === 'held')
    expect(held.map((entry) => entry.trigger)).toEqual(['startup-sweep', 'inputResult'])
    expect(held[0]).toMatchObject({
      from: 'enqueued/busy',
      gate: { verdict: 'pending', gate: 'full-access', code: 'l1-unprobed', reopenedAfter: 'unprobed' },
    })
    // The probe answers: the next idle report submits the original key, once.
    w.state.l1 = 'full'
    await w.engine.advance(sessionId)
    w.core.take(sessionId)
    await w.engine.advance(sessionId)
    expect(w.row(sessionId)?.state).toBe('consumed')
    expect(w.core.ran(sessionId, 'text of k1')).toBe(1)
    expect(w.engine.attention(10)).toEqual([])
  })

  it('an unreadable L1 report holds too; a probe that answered without a boundary parks the input, explained', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    w.state.probeOnOpen = false
    w.state.l1 = 'unreadable'
    await w.engine.sweep('startup')
    expect(w.row(sessionId)).toMatchObject({ state: 'enqueued', reason: 'busy' })
    w.state.l1 = 'unavailable'
    await w.engine.sweep()
    expect(w.row(sessionId)).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
    expect(w.core.state.submits).toEqual([])
    const parked = w.of('k1').find((entry) => entry.to === 'needsOwner/grantRevoked')
    expect(parked).toMatchObject({
      trigger: 'sweep',
      from: 'enqueued/busy',
      gate: {
        verdict: 'refused',
        gate: 'full-access',
        code: 'FULL_ACCESS_UNAVAILABLE',
        missing: 'os-boundary',
        l1: 'unavailable',
      },
    })
    expect(w.warnings.some((line) => line.includes('"to":"needsOwner/grantRevoked"'))).toBe(true)
  })

  it('gates that cannot be read hold the input and say so, naming no gate', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    w.state.readFails = true
    const before = w.row(sessionId)
    await w.engine.sweep('startup')
    expect(w.row(sessionId)).toEqual(before)
    expect(w.of('k1').at(-1)).toMatchObject({
      event: 'held',
      trigger: 'startup-sweep',
      gate: { verdict: 'pending', code: 'gates-unreadable' },
    })
  })

  it('a revoked grant parks the held input before the L1 report is read, and says so', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    w.records.revokeAll(owner)
    const opens = w.state.opens
    await w.engine.sweep('startup')
    expect(w.row(sessionId)).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
    expect(w.core.state.submits).toEqual([])
    expect(w.state.opens, 'a revoked grant opens nothing').toBe(opens)
    expect(w.of('k1').at(-1)).toMatchObject({
      trigger: 'startup-sweep',
      gate: { verdict: 'refused', gate: 'workspace', code: 'WORKSPACE_NOT_AUTHORIZED' },
    })
  })

  it('a live policy without a boundary still refuses after the reopen', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    w.state.live = false
    await w.engine.sweep('startup')
    expect(w.row(sessionId)).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
    expect(w.of('k1').at(-1)?.gate).toMatchObject({
      verdict: 'refused',
      gate: 'live-policy',
      missing: 'os-boundary',
      reopenedAfter: 'unprobed',
      live: { fullAccess: true, osBoundary: false, outwardCheckpoint: true },
    })
  })

  it('an admission while the probe has not run is held, not parked, and runs once the gates pass', async () => {
    const w = world()
    const sessionId = await w.begin()
    w.state.l1 = 'unprobed'
    w.state.probeOnOpen = false
    expect(await w.admit(sessionId, 'k1')).toMatchObject({ state: 'enqueued', reason: 'eligible' })
    expect(w.core.state.submits).toEqual([])
    expect(w.of('k1')[0]).toMatchObject({ trigger: 'admit', gate: { verdict: 'pending' } })
    w.state.l1 = 'full'
    await w.engine.sweep()
    w.core.take(sessionId)
    await w.engine.advance(sessionId)
    expect(w.row(sessionId)?.state).toBe('consumed')
    expect(w.core.ran(sessionId, 'text of k1')).toBe(1)
  })

  it('start and send keep refusing full access while the probe has not run', async () => {
    const w = world()
    const plain = await w.begin(false)
    w.state.l1 = 'unprobed'
    w.state.probeOnOpen = false
    const opens = w.state.opens
    const unavailable = { data: { ...refused('FULL_ACCESS_UNAVAILABLE').data, missing: 'os-boundary' } }
    await expect(w.begin()).rejects.toMatchObject(unavailable)
    await expect(w.port().send(plain, { text: 'more', idempotencyKey: 's1' })).rejects.toMatchObject(
      unavailable,
    )
    expect(w.state.opens, 'neither opens a session to wait for the probe').toBe(opens)
  })

  it('a revoke or prune that matches the held input parks it and records what it matched', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    await w.engine.withdraw(owner, '/elsewhere')
    expect(w.row(sessionId)).toMatchObject({ state: 'enqueued', reason: 'busy' })
    await w.engine.withdraw(owner, '/work/repo')
    expect(w.row(sessionId)).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
    const events = w.traces.filter((entry) => entry.event === 'withdraw')
    expect(events.map(({ scoped, rows, matched }) => ({ scoped, rows, matched }))).toEqual([
      { scoped: true, rows: 1, matched: 0 },
      { scoped: true, rows: 1, matched: 1 },
    ])
    expect(w.of('k1').at(-1)).toMatchObject({ trigger: 'withdraw', to: 'needsOwner/grantRevoked' })
  })

  it('trace lines carry ids, states and gate facts only, never the input text', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    await w.engine.sweep('startup')
    const text = JSON.stringify(w.traces)
    expect(text).not.toContain('text of k1')
    expect(text).toContain(sessionId)
    for (const entry of w.traces) expect(entry.pass).toMatch(/^[0-9a-f]{8}$|^-$/u)
  })

  it('auto-review on or a refused bundle parks the held input as that gate, never opening the session for the probe', async () => {
    for (const refusal of ['auto-review', 'bundle'] as const) {
      const w = world()
      const sessionId = await w.heldAcrossRestart()
      w.state.probeOnOpen = false
      if (refusal === 'auto-review') w.state.autoReview = true
      else w.state.bundleRefused = true
      const opens = w.state.opens
      await w.engine.sweep('startup')
      expect(w.row(sessionId)).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
      expect(w.state.opens, `${refusal} answered first`).toBe(opens)
      expect(w.of('k1').at(-1)?.gate).toMatchObject({
        verdict: 'refused',
        gate: refusal,
        code: refusal === 'auto-review' ? 'AUTO_REVIEW' : 'BUNDLE_UNAVAILABLE',
        l1: 'unprobed',
      })
    }
  })

  it('a workspace read that fails without refusing holds the input; a missing or invalid workspace parks it; start still refuses', async () => {
    const w = world()
    const sessionId = await w.heldAcrossRestart()
    w.state.l1 = 'full'
    w.state.workspace = new Error('workspace catalog closed')
    const before = w.row(sessionId)
    await w.engine.sweep('startup')
    expect(w.row(sessionId)).toEqual(before)
    expect(w.of('k1').at(-1)).toMatchObject({
      event: 'held',
      gate: { verdict: 'pending', gate: 'workspace', code: 'workspace-unreadable' },
    })
    await expect(w.port().start(startOf('other'))).rejects.toMatchObject(refused('WORKSPACE_NOT_AUTHORIZED'))
    for (const answer of [
      new Error('workspace_missing'),
      Object.assign(new Error('workspace directory is invalid: not-found'), {
        name: 'WorkspaceDirectoryError',
      }),
    ]) {
      const v = world()
      const id = await v.heldAcrossRestart()
      v.state.l1 = 'full'
      v.state.workspace = answer
      await v.engine.sweep()
      expect(v.row(id)).toMatchObject({ state: 'needsOwner', reason: 'grantRevoked' })
      expect(v.of('k1').at(-1)?.gate).toMatchObject({ verdict: 'refused', gate: 'workspace' })
    }
  })

  it('a live policy part that could not be read holds the input; start refuses on it as before', async () => {
    for (const unread of ['outward-checkpoint', 'policy'] as const) {
      const w = world()
      const sessionId = await w.heldAcrossRestart()
      w.state.l1 = 'full'
      w.state.unread = unread
      const before = w.row(sessionId)
      await w.engine.sweep('startup')
      expect(w.row(sessionId)).toEqual(before)
      expect(w.core.state.submits).toEqual([])
      expect(w.of('k1').at(-1)).toMatchObject({
        event: 'held',
        gate: { verdict: 'pending', gate: 'live-policy', code: `${unread}-unreadable` },
      })
      await expect(w.port().start(startOf(`again-${unread}`))).rejects.toMatchObject(
        refused('FULL_ACCESS_UNAVAILABLE'),
      )
    }
  })

  it('reads a failed checkpoint read or a missing policy as unread; an answer from the worker as a refusal', async () => {
    const lost = Object.assign(new Error('link closed'), { kind: 'transport-closed' })
    const answered = { code: -32006, message: 'CAPABILITY_DENIED' }
    expect(await readOutwardCheckpoint({ outwardCheckpoint: async () => true })).toEqual({
      outwardCheckpoint: true,
    })
    expect(await readOutwardCheckpoint({ outwardCheckpoint: () => Promise.reject(lost) })).toEqual({
      outwardCheckpoint: false,
      unread: 'outward-checkpoint',
    })
    expect(await readOutwardCheckpoint({ outwardCheckpoint: () => Promise.reject(answered) })).toEqual({
      outwardCheckpoint: false,
    })
    expect(livePolicy(undefined, { outwardCheckpoint: true })).toEqual({
      fullAccess: true,
      osBoundary: false,
      outwardCheckpoint: true,
      unread: 'policy',
    })
    const policy = { permission: { policy: 'full-access' }, sandbox: { enforcement: { level: 'full' } } }
    expect(livePolicy(policy as never, { outwardCheckpoint: true })).toEqual({
      fullAccess: true,
      osBoundary: true,
      outwardCheckpoint: true,
    })
  })
})
