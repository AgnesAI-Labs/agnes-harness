import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { denyPackageAdminAuthority, localPackageAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import { CommandQueue } from '@agnes/daemon-rpc/local/command-queue'
import { createFollowUpRunner } from '@agnes/daemon-rpc/local/follow-up-runner'
import { pluginRowSource } from '@agnes/host'
import {
  type Actor,
  automaticPermissionDecision,
  PACKAGE_ADMIN_METHODS,
  type SessionActivity,
  type SessionViewResult,
} from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { openTestHost, say } from '../../daemon-rpc/test/host.js'
import { createWorkerRequests } from '../src/supervisor/assembly-worker-requests.js'
import { managedSessionPorts, managedWorkspaceRoot } from '../src/supervisor/managed-session-ports.js'
import { grantKey, ManagedSessionRecords } from '../src/supervisor/managed-session-records.js'
import {
  createManagedSessions,
  type ManagedSessionCaller,
  type ManagedSessionPorts,
  type ManagedToolDetail,
  managedLineage,
  managedSessionStatus,
} from '../src/supervisor/managed-sessions.js'
import {
  managedWorkspaceGrants,
  registerManagedWorkspaceGrants,
  revokePackageGrants,
} from '../src/supervisor/managed-workspace-grants.js'
import { createSupervisorProfileServices } from '../src/supervisor/profile-services.js'
import { openWorkspaceCatalog } from '../src/supervisor/workspace-catalog.js'

function table(): TableHandle {
  const db = new DatabaseSync(':memory:')
  return {
    exec(sql, values) {
      if (values?.length) db.prepare(sql).run(...(values as SQLInputValue[]))
      else db.exec(sql)
    },
    get: (sql, values) => db.prepare(sql).get(...((values ?? []) as SQLInputValue[])) as never,
    all: (sql, values) => db.prepare(sql).all(...((values ?? []) as SQLInputValue[])) as never,
    transaction(fn) {
      db.exec('BEGIN')
      try {
        const value = fn()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

type Turn = SessionViewResult['timeline']['turns'][number]
type Node = SessionViewResult['timeline']['nodes'][number]

const caller: ManagedSessionCaller = {
  owner: 'plugin/0123456789abcdef',
  packageId: '@example/companion',
  integrity: 'sha256-a',
  service: 'engine',
}
const other: ManagedSessionCaller = {
  ...caller,
  owner: 'plugin/fedcba9876543210',
  packageId: '@example/other',
}
const start = {
  bundle: '@example/companion#worker',
  workspace: '/work/repo',
  input: 'Fix the failing test.',
  startKey: 'task-1',
  retention: 'task' as const,
}

function world(
  authorize?: ManagedSessionPorts['authorize'],
  real?: Pick<ManagedSessionPorts, 'records' | 'workspaceRoot'>,
) {
  const records = real?.records ?? new ManagedSessionRecords(table())
  const state = {
    enabled: new Set([caller.owner, other.owner]),
    workspaces: new Map([
      ['/work/repo', '/work/repo'],
      ['/work/other', '/work/other'],
    ]),
    models: [{ route: 'local', model: 'model-a' }],
    autoReview: false,
    /** What the daemon knows before a session exists: its opener's switch and the platform probe. */
    gates: { outwardCheckpoint: true, osBoundary: false },
    /** The live session: its sandbox enforcement, and sessions opened without outward command rules. */
    live: { osBoundary: false },
    rulesOff: new Set<string>(),
    /** Whether the opener would ask for command rules for each key it created, read during create. */
    managedAtCreate: [] as boolean[],
    created: [] as { sessionKey: string; cwd: string; agent: string }[],
    queued: new Map<string, { text: string; actor: Actor; commandId: string }[]>(),
    loaded: new Set<string>(),
    activity: [] as SessionActivity[],
    turns: new Map<string, Turn[]>(),
    nodes: new Map<string, Node[]>(),
    usage: undefined as SessionViewResult['timeline']['usage'],
    archived: [] as string[],
    cancelled: [] as string[],
    models_set: [] as unknown[],
    fullAccess: [] as string[],
    tools: new Map<number, ManagedToolDetail>(),
    busy: new Set<string>(),
    presetFullAccess: false,
    forks: new Map<string, string>(),
    /** The identity the owner's approvals carry; undefined when it cannot be read. */
    ownerApprover: 'owner-1' as string | undefined,
  }
  const ports: ManagedSessionPorts = {
    authorize:
      authorize ??
      (async (c) => {
        if (!state.enabled.has(c.owner))
          throw Object.assign(new Error('CAPABILITY_DENIED'), { data: { code: 'CAPABILITY_DENIED' } })
      }),
    records,
    forkParent: (sessionId) => state.forks.get(sessionId),
    workspaceRoot:
      real?.workspaceRoot ??
      (async (path) => {
        const root = state.workspaces.get(path)
        if (!root) throw new Error('workspace_missing')
        return root
      }),
    async resolveAgent(bundle) {
      if (bundle.endsWith('#missing')) throw new Error('not reviewed')
    },
    models: async () => state.models,
    autoReview: async () => state.autoReview,
    fullAccess: async () => state.gates,
    sessions: {
      async create(input) {
        state.managedAtCreate.push(managedLineage(ports, records.opening, input.sessionKey))
        state.created.push(input)
        state.loaded.add(input.sessionKey)
        return input.sessionKey
      },
      async setModel(sessionId, model) {
        state.models_set.push([sessionId, model])
      },
      async setFullAccess(sessionId) {
        state.fullAccess.push(sessionId)
      },
      policy: async (sessionId) => ({
        fullAccess: state.presetFullAccess || state.fullAccess.includes(sessionId),
        osBoundary: state.live.osBoundary,
        outwardCheckpoint: !state.rulesOff.has(sessionId),
      }),
      async submit(sessionId, input) {
        const queue = state.queued.get(sessionId) ?? []
        if (queue.some((item) => item.commandId === input.commandId)) return 'started'
        if (state.busy.has(sessionId)) return 'busy'
        queue.push(input)
        state.queued.set(sessionId, queue)
        return 'started'
      },
      loaded: (sessionId) => state.loaded.has(sessionId),
      activity: async () => state.activity,
      async view(sessionId) {
        const turns = state.turns.get(sessionId) ?? []
        const nodes = state.nodes.get(sessionId) ?? []
        return {
          sessionId,
          readOnly: true,
          lastSeq: Math.max(
            0,
            ...nodes.map((n) => (n.kind === 'approval' ? (n.decidedSeq ?? n.seq) : (n.seq ?? 0))),
            ...turns.map((t) => t.endSeq ?? t.startSeq),
          ),
          timeline: {
            sessionId,
            upto: 0,
            generation: 1,
            opState: null,
            nodes,
            turns,
            ...(state.usage ? { usage: state.usage } : {}),
          },
          history: { hasEarlier: false, startIndex: 0, totalNodes: nodes.length },
        } as unknown as SessionViewResult
      },
      async toolDetail(_sessionId, callSeq) {
        const detail = state.tools.get(callSeq)
        if (!detail) throw new Error('not found')
        return detail
      },
      async ownerApprover() {
        if (state.ownerApprover === undefined) throw new Error('actor unreadable')
        return state.ownerApprover
      },
      async cancel(sessionId) {
        state.cancelled.push(sessionId)
      },
      async archive(sessionId) {
        state.archived.push(sessionId)
      },
    },
  }
  return { state, records, port: createManagedSessions(ports) }
}

const turn = (over: Partial<Turn> & Pick<Turn, 'turn' | 'status'>): Turn =>
  ({
    id: `t${over.turn}`,
    startSeq: over.turn * 10,
    startedAt: '2026-11-10T00:00:00.000Z',
    nodeIds: [],
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
    inherited: false,
    forkable: false,
    ...over,
  }) as Turn

const denied = { data: { code: 'CAPABILITY_DENIED' } }
const refused = (reason: string) => ({ data: { code: 'CAPABILITY_DENIED', reason } })

describe('starting a managed session', () => {
  it('opens one session per start key in an authorized workspace, with backend input identity', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const first = await port(caller).start(start)
    expect(first.created).toBe(true)
    expect(await port(caller).start({ ...start, input: 'again' })).toEqual({
      sessionId: first.sessionId,
      created: false,
    })
    expect(state.created).toEqual([{ sessionKey: first.sessionId, cwd: '/work/repo', agent: start.bundle }])
    const queued = state.queued.get(first.sessionId) ?? []
    expect(queued.map((item) => item.text)).toEqual(['Fix the failing test.'])
    expect(queued[0]?.actor).toMatchObject({
      id: 'plugin:0123456789abcdef',
      attrs: { unattendedApproval: 'notify', managedBy: caller.owner },
    })
    expect(queued[0]?.actor.attrs.interaction).toBeUndefined()
    expect(queued[0]?.actor.attrs.experience).toBeUndefined()
  })

  it('resumes a start that crashed after creating the session without queuing the input twice', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const sessionKey = (await port(caller).start(start)).sessionId
    // A crash before `markStarted`: the record exists but is not started.
    records.insert({
      sessionId: 'x',
      owner: grantKey(caller.packageId, caller.owner),
      startKey: 'task-2',
      bundle: start.bundle,
      workspace: '/work/repo',
      retention: 'task',
      permission: 'default',
      model: null,
      memoryWrites: true,
      skillInstalls: true,
    })
    state.queued.set('x', [])
    const resumed = await port(caller).start({ ...start, startKey: 'task-2' })
    expect(resumed).toEqual({ sessionId: 'x', created: false })
    await port(caller).start({ ...start, startKey: 'task-2' })
    expect(state.queued.get('x')).toHaveLength(1)
    expect(state.queued.get(sessionKey)).toHaveLength(1)
  })

  it.each([
    ['full access', { permission: 'full-access' as const }, 'START_KEY_REUSED'],
    ['another model', { model: { route: 'local', model: 'model-a' } }, 'START_KEY_REUSED'],
    ['memory writes back on', { memoryWrites: true }, 'START_KEY_REUSED'],
    ['skill installs back on', { skillInstalls: true }, 'START_KEY_REUSED'],
    ['ephemeral retention', { retention: 'ephemeral' as const }, 'START_KEY_REUSED'],
    ['another workspace', { workspace: '/work/other' }, 'START_KEY_REUSED'],
  ])(
    'refuses a resume that asks for %s beyond what the crashed start recorded',
    async (_n, change, reason) => {
      const { state, records, port } = world()
      records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
      records.grant(grantKey(caller.packageId, caller.owner), '/work/other')
      state.gates = { outwardCheckpoint: true, osBoundary: true }
      records.insert({
        sessionId: 'x',
        owner: grantKey(caller.packageId, caller.owner),
        startKey: 'task-1',
        bundle: start.bundle,
        workspace: '/work/repo',
        retention: 'task',
        permission: 'default',
        model: null,
        memoryWrites: false,
        skillInstalls: false,
      })
      const resume = { ...start, memoryWrites: false, skillInstalls: false }
      await expect(port(caller).start({ ...resume, ...change })).rejects.toMatchObject(refused(reason))
      expect(state.fullAccess).toEqual([])
      expect(state.models_set).toEqual([])
      expect(state.queued.get('x')).toBeUndefined()
      expect(await port(caller).start(resume)).toEqual({ sessionId: 'x', created: false })
    },
  )

  it('runs the gates again on a resume, so a revoked grant stops it', async () => {
    const { state, records, port } = world()
    records.insert({
      sessionId: 'x',
      owner: grantKey(caller.packageId, caller.owner),
      startKey: 'task-1',
      bundle: start.bundle,
      workspace: '/work/repo',
      retention: 'task',
      permission: 'default',
      model: null,
      memoryWrites: true,
      skillInstalls: true,
    })
    await expect(port(caller).start(start)).rejects.toMatchObject(refused('WORKSPACE_NOT_AUTHORIZED'))
    expect(state.queued.get('x')).toBeUndefined()
  })

  it('refuses and archives a session a Bundle preset put under full access without an OS boundary', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    state.presetFullAccess = true
    await expect(port(caller).start(start)).rejects.toMatchObject({
      data: { reason: 'FULL_ACCESS_UNAVAILABLE', missing: 'os-boundary' },
    })
    expect(state.archived).toHaveLength(1)
    expect([...state.queued.values()].flat()).toEqual([])
    await expect(port(caller).start(start)).rejects.toMatchObject(refused('SESSION_ARCHIVED'))
  })

  it('leaves a start whose opening input lost the inbox unstarted, so a retry queues it', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const sessionKey = `managed-${createHash('sha256')
      .update(`${grantKey(caller.packageId, caller.owner)}\0${start.startKey}`)
      .digest('hex')
      .slice(0, 40)}`
    state.busy.add(sessionKey)
    await expect(port(caller).start(start)).rejects.toMatchObject(refused('SESSION_BUSY'))
    expect(records.get(sessionKey)?.started).toBe(false)
    state.busy.delete(sessionKey)
    expect(await port(caller).start(start)).toEqual({ sessionId: sessionKey, created: false })
    expect(state.queued.get(sessionKey)?.map((item) => item.text)).toEqual([start.input])
  })

  it.each([
    ['an unauthorized workspace', { workspace: '/work/other' }, 'WORKSPACE_NOT_AUTHORIZED'],
    ['an unregistered workspace', { workspace: '/nowhere' }, 'WORKSPACE_NOT_AUTHORIZED'],
    ['another package Bundle', { bundle: '@example/other#worker' }, 'BUNDLE_NOT_OWN'],
    ['an unreviewed Bundle', { bundle: '@example/companion#missing' }, 'BUNDLE_UNAVAILABLE'],
    ['a missing model route', { model: { route: 'cloud', model: 'model-a' } }, 'MODEL_ROUTE_MISSING'],
    [
      'full access while the platform reports no full OS boundary',
      { permission: 'full-access' as const },
      'FULL_ACCESS_UNAVAILABLE',
    ],
  ])('refuses %s and opens nothing', async (_name, change, reason) => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    await expect(port(caller).start({ ...start, ...change })).rejects.toMatchObject(refused(reason))
    expect(state.created).toEqual([])
    expect(records.list(grantKey(caller.packageId, caller.owner))).toEqual([])
  })

  it.each<
    [
      string,
      { outwardCheckpoint?: boolean; osBoundary?: boolean },
      { rulesOff?: boolean; osBoundary?: boolean },
      string,
      number,
    ]
  >([
    ['the opener cannot turn command rules on', { outwardCheckpoint: false }, {}, 'outward-checkpoint', 0],
    ['the platform reports no full OS boundary', { osBoundary: false }, {}, 'os-boundary', 0],
    ['the open session has no outward checkpoint', {}, { rulesOff: true }, 'outward-checkpoint', 1],
    ['the open session runs without a full OS boundary', {}, { osBoundary: false }, 'os-boundary', 1],
  ])(
    'grants full access only when both gates hold: refused when %s',
    async (_label, gates, live, missing, created) => {
      const { state, records, port } = world()
      records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
      state.gates = { outwardCheckpoint: true, osBoundary: true, ...gates }
      state.live = { osBoundary: live.osBoundary ?? true }
      const sessionKey = `managed-${createHash('sha256')
        .update(`${grantKey(caller.packageId, caller.owner)}\0${start.startKey}`)
        .digest('hex')
        .slice(0, 40)}`
      if (live.rulesOff) state.rulesOff.add(sessionKey)
      await expect(port(caller).start({ ...start, permission: 'full-access' })).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED', reason: 'FULL_ACCESS_UNAVAILABLE', missing },
      })
      // Refused before create opens nothing; refused after it archives what it opened.
      expect(state.created).toHaveLength(created)
      expect(state.archived).toHaveLength(created)
      expect([...state.queued.values()].flat()).toEqual([])
    },
  )

  it('grants full access when both gates hold before create and on the open session', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    state.gates = { outwardCheckpoint: true, osBoundary: true }
    state.live = { osBoundary: true }
    const { sessionId } = await port(caller).start({ ...start, permission: 'full-access' })
    expect(state.fullAccess).toEqual([sessionId])
    expect(state.queued.get(sessionId)?.map((item) => item.text)).toEqual([start.input])
  })

  it('refuses and archives any managed session whose open policy has no outward checkpoint', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const sessionKey = `managed-${createHash('sha256')
      .update(`${grantKey(caller.packageId, caller.owner)}\0${start.startKey}`)
      .digest('hex')
      .slice(0, 40)}`
    state.rulesOff.add(sessionKey)
    await expect(port(caller).start(start)).rejects.toMatchObject(refused('OUTWARD_CHECKPOINT_UNAVAILABLE'))
    expect(state.archived).toEqual([sessionKey])
    expect([...state.queued.values()].flat()).toEqual([])
  })

  it('creates a managed session under a key its opener already treats as managed', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const { sessionId } = await port(caller).start(start)
    expect(state.managedAtCreate).toEqual([true])
    expect(records.opening.size).toBe(0)
    expect(managedLineage({ records, forkParent: () => undefined }, records.opening, sessionId)).toBe(true)
  })

  it('refuses while the deployment reviews approvals automatically', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    state.autoReview = true
    await expect(port(caller).start(start)).rejects.toMatchObject(refused('AUTO_REVIEW'))
  })

  it('selects the named model route without falling back', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const model = { route: 'local', model: 'model-a' }
    const { sessionId } = await port(caller).start({ ...start, model })
    expect(state.models_set).toEqual([[sessionId, model]])
  })

  it('marks an ephemeral session input as excluded from task experience', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const { sessionId } = await port(caller).start({ ...start, retention: 'ephemeral' })
    expect(state.queued.get(sessionId)?.[0]?.actor.attrs.experience).toBe('excluded')
  })

  it('turns memory writes and skill installs off for the session when asked', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const plain = await port(caller).start(start)
    const locked = await port(caller).start({
      ...start,
      startKey: 'task-3',
      memoryWrites: false,
      skillInstalls: false,
    })
    expect(state.queued.get(locked.sessionId)?.[0]?.actor.attrs.memoryWrites).toBe('off')
    expect(state.queued.get(plain.sessionId)?.[0]?.actor.attrs.memoryWrites).toBeUndefined()
    expect(port.skillInstallsOff(locked.sessionId)).toBe(true)
    expect(port.skillInstallsOff(plain.sessionId)).toBe(false)
    expect(port.skillInstallsOff('owner-session')).toBe(false)
    expect(await port(caller).send(locked.sessionId, { text: 'more', idempotencyKey: 'k' })).toEqual({
      state: 'started',
    })
    expect(state.queued.get(locked.sessionId)?.[1]?.actor.attrs.memoryWrites).toBe('off')
  })

  it('keeps skill installs off in every session descended from a session that turned them off', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const plain = await port(caller).start(start)
    const locked = await port(caller).start({ ...start, startKey: 'task-3', skillInstalls: false })
    const child = `${locked.sessionId}/01K00000000000000000000000`
    state.forks.set('agnes:fork:a', locked.sessionId)
    state.forks.set('agnes:fork:b', `${child}/01K00000000000000000000001`)
    state.forks.set('agnes:fork:c', 'agnes:fork:a')
    state.forks.set('agnes:fork:plain', plain.sessionId)
    state.forks.set(`${plain.sessionId}/fork`, plain.sessionId)
    for (const key of [
      child,
      `${child}/01K00000000000000000000001`,
      'agnes:fork:a',
      'agnes:fork:a/01K00000000000000000000002',
      'agnes:fork:b',
      'agnes:fork:c',
    ])
      expect({ key, off: port.skillInstallsOff(key) }).toEqual({ key, off: true })
    for (const key of [
      `${plain.sessionId}/01K00000000000000000000003`,
      'agnes:fork:plain',
      `${plain.sessionId}/fork`,
      'owner-session/01K00000000000000000000004',
    ])
      expect({ key, off: port.skillInstallsOff(key) }).toEqual({ key, off: false })
  })

  it('refuses skill installs when a session lineage cannot be resolved', async () => {
    const { state, port } = world()
    state.forks.set('agnes:fork:x', 'agnes:fork:y')
    state.forks.set('agnes:fork:y', 'agnes:fork:x')
    expect(port.skillInstallsOff('agnes:fork:x')).toBe(true)
    expect(port.skillInstallsOff(Array.from({ length: 80 }, (_, i) => `s${i}`).join('/'))).toBe(true)
    const broken = world()
    broken.state.forks.get = () => {
      throw new Error('session principal ownership unavailable')
    }
    expect(() => broken.port.skillInstallsOff('agnes:fork:z')).toThrow('ownership unavailable')
  })

  it('refuses a disabled plugin and leaves its sessions with the owner', async () => {
    const { state, records, port } = world()
    records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const { sessionId } = await port(caller).start(start)
    state.enabled.delete(caller.owner)
    await expect(port(caller).start({ ...start, startKey: 'task-9' })).rejects.toMatchObject(denied)
    await expect(port(caller).send(sessionId, { text: 'more', idempotencyKey: 'k' })).rejects.toMatchObject(
      denied,
    )
    await expect(port(caller).list()).rejects.toMatchObject(denied)
    expect(state.archived).toEqual([])
    state.enabled.add(caller.owner)
    expect((await port(caller).list()).map((s) => s.sessionId)).toEqual([sessionId])
  })
})

describe('driving a managed session', () => {
  async function started() {
    const w = world()
    w.records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const { sessionId } = await w.port(caller).start(start)
    return { ...w, sessionId }
  }

  it.each([
    [
      'the workspace grant is revoked',
      'WORKSPACE_NOT_AUTHORIZED',
      (w: ReturnType<typeof world>) =>
        w.records.revoke(grantKey(caller.packageId, caller.owner), '/work/repo'),
    ],
    [
      'the workspace is no longer registered',
      'WORKSPACE_NOT_AUTHORIZED',
      (w: ReturnType<typeof world>) => w.state.workspaces.delete('/work/repo'),
    ],
    [
      'the model route is gone',
      'MODEL_ROUTE_MISSING',
      (w: ReturnType<typeof world>) => {
        w.state.models = []
      },
    ],
    [
      'approvals are reviewed automatically',
      'AUTO_REVIEW',
      (w: ReturnType<typeof world>) => {
        w.state.autoReview = true
      },
    ],
    [
      'the session now runs under full access without an OS boundary',
      'FULL_ACCESS_UNAVAILABLE',
      (w: ReturnType<typeof world>) => {
        w.state.presetFullAccess = true
      },
    ],
    [
      'the session was reopened without outward command rules',
      'OUTWARD_CHECKPOINT_UNAVAILABLE',
      (w: ReturnType<typeof world>) => {
        for (const record of w.records.list(grantKey(caller.packageId, caller.owner)))
          w.state.rulesOff.add(record.sessionId)
      },
    ],
  ])(
    'refuses a send once %s, queues nothing, and still lets the plugin read and stop',
    async (_label, reason, change) => {
      const w = world()
      w.records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
      const { sessionId } = await w
        .port(caller)
        .start({ ...start, model: { route: 'local', model: 'model-a' } })
      change(w)
      await expect(
        w.port(caller).send(sessionId, { text: 'more', idempotencyKey: 'k' }),
      ).rejects.toMatchObject(refused(reason))
      expect(w.state.queued.get(sessionId)?.map((item) => item.text)).toEqual(['Fix the failing test.'])
      expect(w.records.sendState(grantKey(caller.packageId, caller.owner), sessionId, 'k')).toBeUndefined()
      expect((await w.port(caller).list()).map((item) => item.sessionId)).toEqual([sessionId])
      expect(await w.port(caller).status(sessionId)).toMatchObject({ kind: 'idle' })
      expect(await w.port(caller).events(sessionId)).toMatchObject({ events: [] })
      expect(await w.port(caller).result(sessionId)).toEqual({ turn: null, text: null })
      expect(await w.port(caller).usage(sessionId)).toMatchObject({ cost: null })
      await w.port(caller).interrupt(sessionId)
      await w.port(caller).archive(sessionId)
      expect(w.state.cancelled).toEqual([sessionId])
      expect(w.state.archived).toEqual([sessionId])
    },
  )

  it('sends only while idle, and a reused key is not submitted again', async () => {
    const { state, port, sessionId } = await started()
    state.activity = [{ sessionId, state: 'running' }]
    expect(await port(caller).send(sessionId, { text: 'next', idempotencyKey: 'k1' })).toEqual({
      state: 'notSubmitted',
      reason: 'busy',
    })
    state.activity = []
    expect(await port(caller).send(sessionId, { text: 'next', idempotencyKey: 'k1' })).toEqual({
      state: 'started',
    })
    expect(await port(caller).send(sessionId, { text: 'next', idempotencyKey: 'k1' })).toEqual({
      state: 'notSubmitted',
      reason: 'duplicateKey',
    })
    expect(state.queued.get(sessionId)?.map((item) => item.text)).toEqual(['Fix the failing test.', 'next'])
  })

  it('reports busy when another input wins the inbox, and frees the key', async () => {
    const { state, port, sessionId } = await started()
    state.busy.add(sessionId)
    expect(await port(caller).send(sessionId, { text: 'x', idempotencyKey: 'k' })).toEqual({
      state: 'notSubmitted',
      reason: 'busy',
    })
    state.busy.delete(sessionId)
    expect(await port(caller).send(sessionId, { text: 'x', idempotencyKey: 'k' })).toEqual({
      state: 'started',
    })
  })

  it('treats a waiting turn as busy and flags what it waits for', async () => {
    const { state, port, sessionId } = await started()
    state.activity = [{ sessionId, state: 'waiting', waiting: 'approval' }]
    expect(await port(caller).status(sessionId)).toEqual({ kind: 'active', flags: ['waitingOnApproval'] })
    expect(await port(caller).send(sessionId, { text: 'x', idempotencyKey: 'k' })).toMatchObject({
      reason: 'busy',
    })
    state.activity = [{ sessionId, state: 'waiting', waiting: 'question' }]
    expect(await port(caller).status(sessionId)).toEqual({ kind: 'active', flags: ['waitingOnUserInput'] })
  })

  it('refuses an archived session', async () => {
    const { port, sessionId } = await started()
    await port(caller).archive(sessionId)
    expect(await port(caller).send(sessionId, { text: 'x', idempotencyKey: 'k' })).toEqual({
      state: 'notSubmitted',
      reason: 'archived',
    })
  })

  it('hides every session another row manages, and one recorded under its row alone', async () => {
    const { port, records, sessionId } = await started()
    records.insert({
      sessionId: 'row-only',
      owner: caller.owner,
      startKey: 'task-0',
      bundle: start.bundle,
      workspace: '/work/repo',
      retention: 'task',
      permission: 'default',
      model: null,
      memoryWrites: true,
      skillInstalls: true,
    })
    records.markStarted('row-only')
    expect((await port(caller).list()).map((s) => s.sessionId)).toEqual([sessionId])
    await expect(port(caller).status('row-only')).rejects.toMatchObject(denied)
    await expect(port(caller).archive('row-only')).rejects.toMatchObject(denied)
    expect(await port(caller).start({ ...start, startKey: 'task-0' })).toMatchObject({ created: true })
    expect(await port(other).list()).toEqual([])
    for (const call of [
      () => port(other).send(sessionId, { text: 'x', idempotencyKey: 'k' }),
      () => port(other).status(sessionId),
      () => port(other).events(sessionId),
      () => port(other).result(sessionId),
      () => port(other).usage(sessionId),
      () => port(other).toolResult(sessionId, 1),
      () => port(other).interrupt(sessionId),
      () => port(other).archive(sessionId),
      () => port(caller).status('owner-session'),
    ])
      await expect(call()).rejects.toMatchObject(denied)
  })

  it('reads events, the last result and nullable usage', async () => {
    const { state, port, sessionId } = await started()
    state.nodes.set(sessionId, [
      { kind: 'assistant', id: 'a1', seq: 11, text: 'Looking.' },
      {
        kind: 'tool',
        id: 'c1',
        seq: 12,
        toolUseId: 'u1',
        name: 'shell',
        status: 'completed',
        summary: 'npm test',
        resultSeq: 13,
      },
      {
        kind: 'approval',
        id: 'p1',
        seq: 14,
        state: 'pending',
        summary: 'git push',
        risk: 'always',
        options: ['allow_once', 'reject_once'],
        category: 'permission',
        toolName: 'shell',
      },
      { kind: 'assistant', id: 'a2', seq: 16, text: 'Done.' },
    ] as Node[])
    state.turns.set(sessionId, [
      turn({
        turn: 1,
        status: 'completed',
        reason: 'completed',
        endSeq: 17,
        nodeIds: ['a1', 'c1', 'p1', 'a2'],
      }),
    ])
    const read = await port(caller).events(sessionId)
    expect(read.events.map((e) => e.kind)).toEqual(['text', 'tool', 'approval', 'text', 'turn'])
    expect(read.lastSeq).toBe(17)
    expect((await port(caller).events(sessionId, { afterSeq: 14 })).events.map((e) => e.seq)).toEqual([
      16, 17,
    ])
    expect(await port(caller).result(sessionId)).toEqual({
      turn: { status: 'completed', reason: 'completed' },
      text: 'Done.',
    })
    expect(await port(caller).usage(sessionId)).toEqual({ inputTokens: null, outputTokens: null, cost: null })
    state.usage = {
      totals: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      billingComplete: false,
      cost: { usdMicros: 2500, source: 'estimated', subscription: false },
      context: {},
      model: {},
    } as unknown as SessionViewResult['timeline']['usage']
    expect(await port(caller).usage(sessionId)).toEqual({ inputTokens: 120, outputTokens: 30, cost: null })
  })

  it('archives an ephemeral session once its result is read', async () => {
    const w = world()
    w.records.grant(grantKey(caller.packageId, caller.owner), '/work/repo')
    const { sessionId } = await w.port(caller).start({ ...start, retention: 'ephemeral' })
    expect(await w.port(caller).result(sessionId)).toEqual({ turn: null, text: null })
    expect(w.state.archived).toEqual([])
    w.state.turns.set(sessionId, [turn({ turn: 1, status: 'completed', endSeq: 12 })])
    await w.port(caller).result(sessionId)
    expect(w.state.archived).toEqual([sessionId])
    expect((await w.port(caller).list())[0]?.archived).toBe(true)
  })

  it('gives the shell exit code as a field and null for anything else', async () => {
    const { state, port, sessionId } = await started()
    const shell = (text: string, isError: boolean): ManagedToolDetail => ({
      call: { name: 'shell' },
      result: { content: [{ type: 'text', text }], isError },
    })
    state.tools.set(1, shell('ok\n[exit 0]', false))
    state.tools.set(2, shell('boom\n[exit 2]', true))
    state.tools.set(3, shell('[exit 0]\nCommand stopped at the turn deadline.', true))
    state.tools.set(4, {
      call: { name: 'read' },
      result: { content: [{ type: 'text', text: '[exit 0]' }], isError: false },
    })
    state.tools.set(5, shell('printed [exit 0]\n[exit 1]', true))
    expect(await port(caller).toolResult(sessionId, 1)).toEqual({
      name: 'shell',
      state: 'done',
      isError: false,
      text: 'ok\n[exit 0]',
      exitCode: 0,
    })
    expect((await port(caller).toolResult(sessionId, 2)).exitCode).toBe(2)
    expect((await port(caller).toolResult(sessionId, 3)).exitCode).toBeNull()
    expect((await port(caller).toolResult(sessionId, 4)).exitCode).toBeNull()
    expect((await port(caller).toolResult(sessionId, 5)).exitCode).toBe(1)
  })

  it('tells a call that has not finished from one that finished with no output', async () => {
    const { state, port, sessionId } = await started()
    state.tools.set(1, { call: { name: 'shell' } })
    state.tools.set(2, { call: { name: 'write' }, result: { content: [], isError: false } })
    expect(await port(caller).toolResult(sessionId, 1)).toMatchObject({ state: 'pending', text: '' })
    expect(await port(caller).toolResult(sessionId, 2)).toMatchObject({
      state: 'done',
      isError: false,
      text: '',
    })
  })

  describe('how an approval ended', () => {
    const approval = (over: Record<string, unknown>) =>
      ({
        kind: 'approval',
        id: 'p1',
        seq: 14,
        state: 'pending',
        summary: 'git push',
        risk: 'always',
        options: ['allow_once', 'reject_once'],
        category: 'permission',
        ...over,
      }) as Node
    const ended = (verdict: string, via = 'human', byLabel = 'owner-1') =>
      approval({ state: 'decided', decidedSeq: 20, decision: { verdict, via, byLabel } })
    const outcomes = async (w: Awaited<ReturnType<typeof started>>, afterSeq?: number): Promise<unknown[]> =>
      (
        await w.port(caller).events(w.sessionId, afterSeq === undefined ? undefined : { afterSeq })
      ).events.filter((e) => e.kind === 'approvalOutcome')

    it('reports an approval the consumer already read as pending when it later ends', async () => {
      const w = await started()
      w.state.nodes.set(w.sessionId, [approval({})])
      const first = await w.port(caller).events(w.sessionId)
      expect(first.events.map((e) => e.kind)).toEqual(['approval'])
      expect(first.lastSeq).toBe(14)
      for (const [verdict, outcome] of [
        ['allowed-once', 'allowed'],
        ['allowed-session', 'allowed'],
        ['allowed-permanent', 'allowed'],
        ['rejected', 'rejected'],
      ] as const) {
        w.state.nodes.set(w.sessionId, [ended(verdict)])
        const read = await w.port(caller).events(w.sessionId, { afterSeq: first.lastSeq })
        expect(read.events).toEqual([
          { kind: 'approvalOutcome', seq: 20, approvalSeq: 14, outcome, via: 'person' },
        ])
        expect(read.lastSeq).toBe(20)
        expect(await outcomes(w, read.lastSeq)).toEqual([])
      }
    })

    it('reports an expired approval, whoever had answered it before', async () => {
      const w = await started()
      w.state.nodes.set(w.sessionId, [
        approval({ state: 'expired', decidedSeq: 21, decision: { verdict: 'expired', via: 'human' } }),
      ])
      expect(await outcomes(w, 14)).toEqual([
        { kind: 'approvalOutcome', seq: 21, approvalSeq: 14, outcome: 'expired', via: 'automatic' },
      ])
    })

    it('reports a full-access allow, which is never pending, right after its approval event', async () => {
      const w = await started()
      w.state.nodes.set(w.sessionId, [
        approval({
          state: 'decided',
          decidedSeq: 14,
          decision: { verdict: 'allowed-once', via: 'full-access', reason: 'full-access', byLabel: 'x' },
        }),
      ])
      const read = await w.port(caller).events(w.sessionId)
      expect(read.events).toMatchObject([
        { kind: 'approval', seq: 14, state: 'decided' },
        { kind: 'approvalOutcome', seq: 14, approvalSeq: 14, outcome: 'allowed', via: 'full-access' },
      ])
    })

    it('never reports a person unless the owner identity answered', async () => {
      const w = await started()
      w.state.nodes.set(w.sessionId, [ended('rejected', 'human', 'someone-else')])
      expect(await outcomes(w, 14)).toMatchObject([{ outcome: 'rejected', via: 'automatic' }])
      w.state.nodes.set(w.sessionId, [ended('rejected', 'system')])
      expect(await outcomes(w, 14)).toMatchObject([{ via: 'automatic' }])
      w.state.nodes.set(w.sessionId, [
        approval({ state: 'decided', decidedSeq: 20, decision: { verdict: 'rejected', via: 'human' } }),
      ])
      expect(await outcomes(w, 14)).toMatchObject([{ via: 'automatic' }])
      w.state.nodes.set(w.sessionId, [ended('rejected')])
      w.state.ownerApprover = undefined
      expect(await outcomes(w, 14)).toMatchObject([{ outcome: 'rejected', via: 'automatic' }])
    })

    it('says nothing about an approval that is still pending, or that ended before the cursor', async () => {
      const w = await started()
      w.state.nodes.set(w.sessionId, [approval({})])
      expect(await outcomes(w)).toEqual([])
      w.state.nodes.set(w.sessionId, [ended('rejected')])
      expect(await outcomes(w, 20)).toEqual([])
      expect((await w.port(caller).events(w.sessionId, { afterSeq: 20 })).events).toEqual([])
    })
  })

  it('interrupts its own session', async () => {
    const { state, port, sessionId } = await started()
    await port(caller).interrupt(sessionId)
    expect(state.cancelled).toEqual([sessionId])
  })
})

it('computes status from runtime facts', () => {
  expect(managedSessionStatus({ loaded: false, activity: undefined, lastTurn: undefined })).toEqual({
    kind: 'notLoaded',
    flags: [],
  })
  expect(managedSessionStatus({ loaded: true, activity: undefined, lastTurn: undefined })).toEqual({
    kind: 'idle',
    flags: [],
  })
  expect(
    managedSessionStatus({
      loaded: true,
      activity: undefined,
      lastTurn: { status: 'failed', reason: 'error' },
    }),
  ).toEqual({
    kind: 'systemError',
    flags: [],
  })
  expect(
    managedSessionStatus({
      loaded: false,
      activity: { sessionId: 's', state: 'running' },
      lastTurn: undefined,
    }),
  ).toEqual({
    kind: 'active',
    flags: [],
  })
})

it('asks for outward command rules for a managed session, its children and forks, and an unreadable lineage', () => {
  const records = new ManagedSessionRecords(table())
  records.insert({
    sessionId: 'managed-a',
    owner: caller.owner,
    startKey: 'k',
    bundle: start.bundle,
    workspace: '/work/repo',
    retention: 'task',
    permission: 'default',
    model: null,
    memoryWrites: true,
    skillInstalls: true,
  })
  const forks = new Map([
    ['fork-of-a', 'managed-a'],
    ['loop-1', 'loop-2'],
    ['loop-2', 'loop-1'],
  ])
  const ports = { records, forkParent: (key: string) => forks.get(key) }
  const managed = (key: string, opening: ReadonlySet<string> = new Set()) =>
    managedLineage(ports, opening, key)
  expect(managed('managed-a')).toBe(true)
  expect(managed('managed-a/child-1')).toBe(true)
  expect(managed('fork-of-a')).toBe(true)
  expect(managed('fork-of-a/child-2')).toBe(true)
  expect(managed('managed-b', new Set(['managed-b']))).toBe(true)
  expect(managed('loop-1')).toBe(true)
  expect(managed('ordinary')).toBe(false)
  expect(managed('ordinary/child')).toBe(false)
  expect(() =>
    managedLineage(
      {
        records,
        forkParent: () => {
          throw new Error('ownership unreadable')
        },
      },
      new Set(),
      'ordinary',
    ),
  ).toThrow()
})

describe('the managed session owner', () => {
  const installed = (id: string, rowId: string) => {
    const directory = mkdtempSync(join(tmpdir(), 'managed-owner-'))
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: id, agnes: { plugins: [{ id: rowId, export: 'engine', apiRange: '^5.0.0' }] } }),
    )
    return {
      id,
      directory,
      enabled: true,
      trusted: true,
      blockers: [],
      entry: {
        integrity: `sha256-${rowId}`,
        declaredCapabilities: { managedServices: [{ id: 'engine', scope: 'profile', sessions: true }] },
      },
    }
  }
  const a = installed('@example/companion', 'companion:engine')
  const b = installed('@example/other', 'other:engine')
  const identity = (pkg: typeof a, rowId: string): ManagedSessionCaller => ({
    owner: pluginRowSource(rowId),
    packageId: pkg.id,
    integrity: pkg.entry.integrity,
    service: 'engine',
  })
  const authority = () =>
    createSupervisorProfileServices({
      runtime: {
        manager: { inventory: async () => ({ profile: 'p', hash: 'h', packages: [a, b] }) },
        profileDirectory: async () => '/profile',
      },
      profile: 'p',
      pool: {},
      repo: undefined,
      profileHash: 'h',
      clock: () => 0,
      ownership: { resolve: () => undefined },
      workspaces: {},
      registry: {},
    } as unknown as Parameters<typeof createSupervisorProfileServices>[0]).managedSessionAuthority

  it("refuses a caller that names another package's row as owner, for every operation and its grants", async () => {
    const { records, port } = world(authority())
    const own = identity(a, 'companion:engine')
    const victim = identity(b, 'other:engine')
    const forged = { ...own, owner: victim.owner }
    records.grant(grantKey(victim.packageId, victim.owner), '/work/repo')
    const victimSession = await port(victim).start({ ...start, bundle: '@example/other#worker' })
    const calls: [string, () => Promise<unknown>][] = [
      ['start', () => port(forged).start(start)],
      ['send', () => port(forged).send(victimSession.sessionId, { text: 'x', idempotencyKey: 'k' })],
      ['list', () => port(forged).list()],
      ['status', () => port(forged).status(victimSession.sessionId)],
      ['events', () => port(forged).events(victimSession.sessionId)],
      ['result', () => port(forged).result(victimSession.sessionId)],
      ['usage', () => port(forged).usage(victimSession.sessionId)],
      ['toolResult', () => port(forged).toolResult(victimSession.sessionId, 1)],
      ['interrupt', () => port(forged).interrupt(victimSession.sessionId)],
      ['archive', () => port(forged).archive(victimSession.sessionId)],
    ]
    for (const [, call] of calls) await expect(call()).rejects.toMatchObject(denied)
    await expect(port(own).start(start)).rejects.toMatchObject(refused('WORKSPACE_NOT_AUTHORIZED'))
    expect(await port(victim).list()).toHaveLength(1)
  })

  it('serves a managed-session request only on the shared session worker profile lane', async () => {
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
    const calls: unknown[] = []
    services.managedSessions.port = (c) =>
      ({ list: async (...args: unknown[]) => calls.push([c.owner, ...args]) }) as never
    const params = { ...identity(a, 'companion:engine'), action: 'list', args: [] }
    for (const lane of [
      { sharedWorker: false, sessionKey: '@profile' },
      { sharedWorker: true, sessionKey: 'session-1' },
      { sharedWorker: true, sessionKey: 'managed-0123/01K00000000000000000000000' },
      { sharedWorker: false, sessionKey: 'session-1' },
    ])
      await expect(services.ownedSession(lane, params)).rejects.toMatchObject(refused('MANAGED_SESSION_LANE'))
    expect(calls).toEqual([])
    await services.ownedSession({ sharedWorker: true, sessionKey: '@profile' }, params)
    expect(calls).toEqual([[pluginRowSource('companion:engine')]])
  })

  it("accepts only an owner that is one of the calling package's own plugin rows", async () => {
    const authorize = authority()
    await expect(authorize(identity(a, 'companion:engine'))).resolves.toBeUndefined()
    await expect(authorize(identity(a, 'companion:other-row'))).rejects.toMatchObject(denied)
    await expect(
      authorize({ ...identity(a, 'companion:engine'), integrity: 'sha256-x' }),
    ).rejects.toMatchObject(denied)
  })

  describe('workspaces the owner grants', () => {
    const bare = {
      ...installed('@example/bare', 'bare:engine'),
      entry: { integrity: 'sha256-bare', declaredCapabilities: {} },
    }
    const methods = ['list', 'grant', 'revoke'] as const
    let nextId = 1

    async function setup(installedPackages: unknown[] = [a, b, bare]) {
      const base = await realpath(mkdtempSync(join(tmpdir(), 'managed-grants-')))
      const [home, repo, gone] = [join(base, 'home'), join(base, 'repo'), join(base, 'gone')]
      for (const dir of [home, join(home, 'data'), repo, gone]) await mkdir(dir)
      const link = join(base, 'link')
      await symlink(repo, link)
      const catalog = await openWorkspaceCatalog({
        dataDir: join(home, 'data'),
        ownerHome: home,
        tables: undefined,
        sessions: new MemorySessionWorkspaces(),
        clock: () => 0,
        workspaceRoot: undefined,
        documentsDirectory: async () => {
          throw new Error('no documents')
        },
      })
      await catalog.add(repo)
      await catalog.add(gone)
      const records = new ManagedSessionRecords(table())
      const profile = createSupervisorProfileServices({
        runtime: {
          manager: { inventory: async () => ({ profile: 'p', hash: 'h', packages: installedPackages }) },
          profileDirectory: async () => '/profile',
        },
        profile: 'p',
        pool: {},
        repo: undefined,
        profileHash: 'h',
        clock: () => 0,
        ownership: { resolve: () => undefined },
        workspaces: {},
        registry: {},
      } as unknown as Parameters<typeof createSupervisorProfileServices>[0])
      const workspaceRoot = managedWorkspaceRoot(catalog)
      const grants = managedWorkspaceGrants({
        records,
        packages: profile.managedSessionPackages,
        workspaceRoot,
        canonical: async (path) => (await catalog.validate(path).catch(() => undefined))?.path,
      })
      const endpoint = (authority = localPackageAdminAuthority()) => {
        const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
        Object.assign(ep.conn, {
          authKind: 'local',
          credentialKind: 'local',
          clientId: 'owner',
          initialized: true,
        })
        registerManagedWorkspaceGrants(ep, authority, grants)
        return ep
      }
      const ep = endpoint()
      const call = async (target: LocalEndpoint, method: (typeof methods)[number], params: unknown) =>
        (await target.handle({
          jsonrpc: '2.0',
          id: nextId++,
          method: `_agnes/v1/admin.managedWorkspaces.${method}`,
          params,
        })) as { result?: Record<string, unknown>; error?: { data?: { code?: string } } }
      const managed = world(profile.managedSessionAuthority, { records, workspaceRoot })
      const all = () =>
        [a, b, bare].flatMap((pkg) =>
          records.grants(grantKey(pkg.id, pluginRowSource(`${pkg.id.slice(9)}:engine`))),
        )
      return {
        repo,
        link,
        gone,
        ep,
        endpoint,
        call,
        managed,
        all,
        records,
        profile,
        grants,
        owner: identity(a, 'companion:engine'),
      }
    }

    it('lets a managed start through after the owner grants the workspace, however the path is spelled', async () => {
      const { repo, link, ep, call, managed, owner } = await setup()
      await expect(managed.port(owner).start({ ...start, workspace: repo })).rejects.toMatchObject(
        refused('WORKSPACE_NOT_AUTHORIZED'),
      )
      expect((await call(ep, 'grant', { packageId: a.id, workspace: `${link}/` })).result).toEqual({
        packageId: a.id,
        workspace: repo,
        changed: true,
      })
      expect((await call(ep, 'grant', { packageId: a.id, workspace: repo })).result?.changed).toBe(false)
      const first = await managed.port(owner).start({ ...start, workspace: repo })
      expect(first.created).toBe(true)
      expect(managed.state.created[0]?.cwd).toBe(repo)
      expect(
        (await managed.port(owner).start({ ...start, workspace: link, startKey: 'task-2' })).created,
      ).toBe(true)
      const listed = (await call(ep, 'list', {})).result
      expect(listed).toEqual({ items: [{ packageId: a.id, workspace: repo }] })
      expect(JSON.stringify(listed)).not.toContain('plugin/')
      expect((await call(ep, 'list', { packageId: b.id })).result).toEqual({ items: [] })
    })

    it('refuses the next send once revoked, and leaves a running turn alone', async () => {
      const { repo, link, gone, ep, call, managed, owner, all } = await setup()
      await call(ep, 'grant', { packageId: a.id, workspace: repo })
      await call(ep, 'grant', { packageId: a.id, workspace: gone })
      const { sessionId } = await managed.port(owner).start({ ...start, workspace: repo })
      managed.state.activity = [{ sessionId, state: 'running' } as SessionActivity]
      expect((await call(ep, 'revoke', { packageId: a.id, workspace: link })).result).toEqual({
        packageId: a.id,
        workspace: repo,
        changed: true,
      })
      expect(managed.state.cancelled).toEqual([])
      expect((await managed.port(owner).status(sessionId)).kind).toBe('active')
      managed.state.activity = []
      await expect(
        managed.port(owner).send(sessionId, { text: 'more', idempotencyKey: 'k1' }),
      ).rejects.toMatchObject(refused('WORKSPACE_NOT_AUTHORIZED'))
      expect(managed.state.queued.get(sessionId)).toHaveLength(1)
      // A workspace deleted since it was granted can still be revoked by the path list printed.
      await rm(gone, { recursive: true })
      expect((await call(ep, 'revoke', { packageId: a.id, workspace: gone })).result?.changed).toBe(true)
      expect(all()).toEqual([])
      expect((await call(ep, 'revoke', { packageId: a.id, workspace: repo })).result?.changed).toBe(false)
    })

    it('refuses an unknown package, a package without managed sessions and an unregistered workspace, storing nothing', async () => {
      const { repo, ep, call, all } = await setup()
      const outside = await realpath(mkdtempSync(join(tmpdir(), 'managed-unregistered-')))
      const cases: [unknown, string][] = [
        [{ packageId: '@example/missing', workspace: repo }, 'PACKAGE_NOT_INSTALLED'],
        [{ packageId: bare.id, workspace: repo }, 'PACKAGE_WITHOUT_MANAGED_SESSIONS'],
        [{ packageId: a.id, workspace: outside }, 'WORKSPACE_NOT_REGISTERED'],
        [{ packageId: a.id, workspace: join(outside, 'absent') }, 'WORKSPACE_NOT_REGISTERED'],
      ]
      for (const [params, code] of cases)
        expect((await call(ep, 'grant', params)).error?.data?.code, code).toBe(code)
      expect((await call(ep, 'list', { packageId: '@example/missing' })).error?.data?.code).toBe(
        'PACKAGE_NOT_INSTALLED',
      )
      expect(all()).toEqual([])
    })

    it('answers only the local owner on the Unix admin connection', async () => {
      const { repo, ep, endpoint, call, all } = await setup()
      const web = endpoint(denyPackageAdminAuthority)
      const params = {
        list: {},
        grant: { packageId: a.id, workspace: repo },
        revoke: { packageId: a.id, workspace: repo },
      }
      for (const method of methods) {
        expect((await call(web, method, params[method])).error?.data?.code, method).toBe('CAPABILITY_DENIED')
        for (const conn of [
          { authKind: 'jwt', credentialKind: 'jwt' },
          { authKind: 'local', credentialKind: 'channel' },
          { authKind: 'source-auth', credentialKind: 'local' },
        ]) {
          const other = endpoint()
          Object.assign(other.conn, conn)
          expect((await call(other, method, params[method])).error?.data?.code, method).toBe(
            'CAPABILITY_DENIED',
          )
        }
      }
      expect(all()).toEqual([])
      expect((await call(ep, 'grant', params.grant)).result?.changed).toBe(true)
    })

    it('is not reachable from the managed-service lane, the plugin port or package administration', async () => {
      const { managed, owner } = await setup()
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
      services.managedSessions.port = (c) => managed.port(c)
      for (const action of ['grant', 'revoke', 'grants'])
        await expect(
          services.ownedSession(
            { sharedWorker: true, sessionKey: '@profile' },
            { ...owner, action, args: [owner.owner, '/work/repo'] },
          ),
        ).rejects.toMatchObject(denied)
      expect(Object.keys(managed.port(owner)).filter((key) => /grant|revoke|workspace/i.test(key))).toEqual(
        [],
      )
      expect(Object.keys(PACKAGE_ADMIN_METHODS).filter((name) => name.includes('managedWorkspaces'))).toEqual(
        [],
      )
    })

    const rowsOf = (pkg: typeof a, rowId: string) =>
      writeFileSync(
        join(pkg.directory, 'package.json'),
        JSON.stringify({
          name: pkg.id,
          agnes: { plugins: [{ id: rowId, export: 'engine', apiRange: '^5.0.0' }] },
        }),
      )
    const afterwards = { ...start, startKey: 'after' }

    it('drops the grants of a removed package and keeps the others, so a package installed later starts with none', async () => {
      const packages: unknown[] = [a, b, bare]
      const { repo, ep, call, managed, owner, records } = await setup(packages)
      await call(ep, 'grant', { packageId: a.id, workspace: repo })
      records.grant(grantKey(b.id, pluginRowSource('other:engine')), repo)
      await managed.port(owner).start({ ...start, workspace: repo })
      packages.splice(packages.indexOf(a), 1)
      expect((await call(ep, 'list', {})).result).toEqual({ items: [{ packageId: b.id, workspace: repo }] })
      expect(records.grants(grantKey(a.id, owner.owner))).toEqual([])
      expect(records.grants(grantKey(b.id, pluginRowSource('other:engine')))).toEqual([repo])
      packages.push(a)
      await expect(managed.port(owner).start({ ...afterwards, workspace: repo })).rejects.toMatchObject(
        refused('WORKSPACE_NOT_AUTHORIZED'),
      )
      await call(ep, 'grant', { packageId: a.id, workspace: repo })
      expect((await managed.port(owner).start({ ...afterwards, workspace: repo })).created).toBe(true)
    })

    it('drops the grant of a row an update renamed away, so a later update back to the old id inherits nothing', async () => {
      const renamed = installed('@example/renamed', 'old:engine')
      const { repo, ep, call, records, grants } = await setup([a, b, bare, renamed])
      const old = grantKey(renamed.id, pluginRowSource('old:engine'))
      await call(ep, 'grant', { packageId: renamed.id, workspace: repo })
      rowsOf(renamed, 'new:engine')
      await grants.prune()
      expect(records.grants(old)).toEqual([])
      rowsOf(renamed, 'old:engine')
      expect((await call(ep, 'list', { packageId: renamed.id })).result).toEqual({ items: [] })
      expect(records.granted(old, repo)).toBe(false)
    })

    it('drops the grants of a package whose directory cannot be read', async () => {
      const broken = installed('@example/broken', 'broken:engine')
      const { repo, ep, call, records } = await setup([a, b, bare, broken])
      await call(ep, 'grant', { packageId: broken.id, workspace: repo })
      await call(ep, 'grant', { packageId: a.id, workspace: repo })
      await rm(join(broken.directory, 'package.json'))
      expect((await call(ep, 'list', {})).result).toEqual({ items: [{ packageId: a.id, workspace: repo }] })
      expect(records.grantOwners()).toEqual([grantKey(a.id, pluginRowSource('companion:engine'))])
    })

    it('prunes a seeded orphan at startup, and never lists or honors one', async () => {
      const { repo, ep, call, managed, records, grants, owner } = await setup()
      const ghost = pluginRowSource('ghost:engine')
      records.grant(ghost, repo)
      await grants.prune()
      expect(records.grantOwners()).toEqual([])
      records.grant(ghost, repo)
      expect((await call(ep, 'list', {})).result).toEqual({ items: [] })
      records.grant(ghost, repo)
      await expect(
        managed.port({ ...owner, owner: ghost }).start({ ...start, workspace: repo }),
      ).rejects.toMatchObject(denied)
    })

    it('refuses a plugin row another installed package also declares, at grant and on start and send', async () => {
      const clash = installed('@example/clash', 'companion:engine')
      const packages: unknown[] = [a, b, bare]
      const { repo, ep, call, managed, owner, records, all } = await setup(packages)
      await call(ep, 'grant', { packageId: a.id, workspace: repo })
      const { sessionId } = await managed.port(owner).start({ ...start, workspace: repo })
      packages.push(clash)
      for (const packageId of [a.id, clash.id])
        expect((await call(ep, 'grant', { packageId, workspace: repo })).error?.data?.code).toBe(
          'PLUGIN_ROW_AMBIGUOUS',
        )
      const ambiguous = { data: { code: 'CAPABILITY_DENIED', reason: 'PLUGIN_ROW_AMBIGUOUS' } }
      await expect(
        managed.port(owner).start({ ...start, workspace: repo, startKey: 'task-2' }),
      ).rejects.toMatchObject(ambiguous)
      await expect(
        managed.port(owner).send(sessionId, { text: 'more', idempotencyKey: 'k1' }),
      ).rejects.toMatchObject(ambiguous)
      await expect(
        managed
          .port(identity(clash, 'companion:engine'))
          .start({ ...start, workspace: repo, startKey: 't3' }),
      ).rejects.toMatchObject(ambiguous)
      expect(records.grants(grantKey(a.id, owner.owner))).toEqual([repo])
      expect(all()).toEqual([repo])
    })

    it('gives a later package that declares a row an update renamed away none of its grants, even when no prune ran', async () => {
      const renamed = installed('@example/renamed', 'old:engine')
      const heir = installed('@example/heir', 'old:engine')
      const packages: unknown[] = [a, b, bare, renamed]
      const { repo, ep, call, managed } = await setup(packages)
      await call(ep, 'grant', { packageId: renamed.id, workspace: repo })
      rowsOf(renamed, 'new:engine')
      packages.push(heir)
      await expect(
        managed
          .port(identity(heir, 'old:engine'))
          .start({ ...start, bundle: `${heir.id}#worker`, workspace: repo }),
      ).rejects.toMatchObject(refused('WORKSPACE_NOT_AUTHORIZED'))
    })

    it('gives the remaining package that shares a removed package row none of its grants or sessions, even when no prune ran', async () => {
      const clash = installed('@example/clash', 'companion:engine')
      const packages: unknown[] = [a, b, bare]
      const { repo, ep, call, managed, owner } = await setup(packages)
      await call(ep, 'grant', { packageId: a.id, workspace: repo })
      const { sessionId } = await managed.port(owner).start({ ...start, workspace: repo })
      packages.push(clash)
      packages.splice(packages.indexOf(a), 1)
      const heir = managed.port(identity(clash, 'companion:engine'))
      const own = { ...start, bundle: `${clash.id}#worker`, workspace: repo }
      await expect(heir.start(own)).rejects.toMatchObject(refused('WORKSPACE_NOT_AUTHORIZED'))
      expect(await heir.list()).toEqual([])
      for (const reach of [
        () => heir.send(sessionId, { text: 'x', idempotencyKey: 'k' }),
        () => heir.status(sessionId),
        () => heir.events(sessionId),
        () => heir.result(sessionId),
        () => heir.usage(sessionId),
        () => heir.toolResult(sessionId, 1),
        () => heir.interrupt(sessionId),
        () => heir.archive(sessionId),
      ])
        await expect(reach()).rejects.toMatchObject(denied)
      expect(managed.state.cancelled).toEqual([])
      expect(managed.state.archived).toEqual([])
      await call(ep, 'grant', { packageId: clash.id, workspace: repo })
      const opened = await heir.start(own)
      expect(opened).toMatchObject({ created: true })
      expect(opened.sessionId).not.toBe(sessionId)
    })

    it('revokes every grant of a package being removed and no other, so the same package id installed again starts with none', async () => {
      const { repo, gone, ep, call, managed, owner, records } = await setup()
      await call(ep, 'grant', { packageId: a.id, workspace: repo })
      await call(ep, 'grant', { packageId: a.id, workspace: gone })
      await call(ep, 'grant', { packageId: b.id, workspace: repo })
      revokePackageGrants(records, a.id)
      await expect(managed.port(owner).start({ ...start, workspace: repo })).rejects.toMatchObject(
        refused('WORKSPACE_NOT_AUTHORIZED'),
      )
      const other = identity(b, 'other:engine')
      expect(
        (await managed.port(other).start({ ...start, bundle: '@example/other#worker', workspace: repo }))
          .created,
      ).toBe(true)
    })
  })
})

describe('package installs in a session that turned installs off', () => {
  const context = {
    policy: 'full-access',
    actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    sessionKey: 'locked',
    sessionId: 'backend-locked',
    epoch: 0,
  }
  const dispatcher = () => {
    const dir = mkdtempSync(join(tmpdir(), 'install-gate-'))
    const ask = vi.fn(async () => undefined)
    const state = {
      o: { config: { dataDir: dir }, profile: { name: 'p' } },
      ownerHome: dir,
      conns: new Set(),
      workspaces: new Map(),
      sessionOwnership: { resolve: () => undefined },
      workspaceCatalog: {},
      resourceControlDirectory: dir,
      resourceControl: { service: {} },
      notices: { emit: () => undefined },
      inflightConn: new Map(),
      pool: { businessWorker: () => undefined },
      registry: {},
      prompter: { ask },
      profilePorts: {
        managedSessions: { skillInstallsOff: (key: string) => key === 'locked' },
      },
      savedSkills: { installers: {} },
    }
    const dispatch = createWorkerRequests(state as never, { own: () => undefined } as never)
    return { ask, dispatch }
  }

  it.each(['skill-install', 'refinement-save', 'plugin-manage', 'mcp-manage'])(
    'refuses %s before any approval, even under full access',
    async (method) => {
      const { ask, dispatch } = dispatcher()
      await expect(
        dispatch(
          'locked',
          { method, requestId: 'r1', params: {}, permissionContext: context } as never,
          new AbortController().signal,
          undefined as never,
        ),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED', reason: 'MANAGED_SKILL_INSTALLS_OFF' } })
      expect(ask).not.toHaveBeenCalled()
    },
  )

  it('shows full access would auto-allow plugin and MCP installs without the flag', () => {
    for (const purpose of ['skills.install', 'plugin.publish', 'mcp.connect'])
      expect(automaticPermissionDecision(context, purpose)).toMatchObject({ verdict: 'allowed-once' })
  })
})

describe('submitting to a real session', () => {
  it('runs the turn for the input it queued, without a user prompt', async () => {
    const h = await openTestHost({ script: [say('managed answer')] })
    const commandQueue = new CommandQueue()
    try {
      const core = await h.host.createSession({ cwd: h.dataDir })
      const entry = { key: 'managed-real', ac: new AbortController(), inflight: null, session: core }
      const continueTurn = createFollowUpRunner(
        { commandQueue, activationBarrier: h.host.activationBarrier },
        async () => undefined,
      )
      const managed = managedSessionPorts({
        socketPath: '',
        serverIdentity: { pid: 0, processStartId: '' },
        records: new ManagedSessionRecords(table()),
        authorize: async () => undefined,
        forkParent: () => undefined,
        workspaces: {} as never,
        models: async () => [],
        registry: { get: () => entry as never, open: async () => entry as never },
        commandQueue,
        continueTurn: (queued) => continueTurn(queued as never),
        opensWithCommandRules: true,
        osBoundary: async () => false,
      })
      expect(
        await managed.ports.sessions.submit('managed-real', {
          text: 'Fix the failing test.',
          actor: core.d.actor,
          commandId: 'start:task-1',
        }),
      ).toBe('started')
      await vi.waitFor(async () => {
        const replies = await core.scan({ type: 'assistant/message', limit: 10 })
        expect(replies.map((row) => JSON.stringify(row.data))).toEqual([
          expect.stringContaining('managed answer'),
        ])
      })
      expect((await core.controls.state()).pending).toEqual([])
      await managed.close()
    } finally {
      await commandQueue.close()
      await h.close()
    }
  })
})
