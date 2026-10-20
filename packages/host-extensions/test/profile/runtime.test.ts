import { setImmediate as nextTurn } from 'node:timers/promises'
import { MemoryStorage } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type {
  PersistenceMetadataNamespace,
  PersistenceMetadataPort,
  ServiceContext,
  ServiceDef,
} from '@agnes/extension-api'
import type {
  Actor,
  DecisionSnapshot,
  JsonValue,
  ProfileServiceReceipt,
  ServiceEffectPolicy,
} from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { ServiceRegistry } from '../../src/ext-host/services.js'
import { ProfileActivations } from '../../src/profile/activation.js'
import { ProfileManagedResources } from '../../src/profile/managed.js'
import { registerManagedServices } from '../../src/profile/managed-services.js'
import { ownedStore } from '../../src/profile/owned-store.js'
import { createProfileServiceRuntime } from '../../src/profile/runtime.js'
import { ProfileWakeBindings } from '../../src/profile/wakes.js'

const owner = 'plugin/0123456789abcdef'
const providerVersions = ['1.0.0', '0.1.0-alpha.0', '1.2.3+build.4'] as const
const actor: Actor = { id: 'operator', org: 'local', role: 'user', deptPath: [], attrs: {} }
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const policy: ServiceEffectPolicy = {
  isDestructive: true,
  isOpenWorld: true,
  requiresApproval: 'always',
  replay: 'never',
  approvalScopes: [],
}
const schema = {
  type: 'object',
  properties: { value: { type: 'number' } },
  required: ['value'],
  additionalProperties: false,
} as const
function metadata(): PersistenceMetadataPort {
  const spaces = new Map<string, Map<string, unknown>>()
  return {
    namespace(owner, name): PersistenceMetadataNamespace {
      const key = `${owner}\0${name}`
      const map = spaces.get(key) ?? new Map<string, unknown>()
      spaces.set(key, map)
      return {
        get: (key) => structuredClone(map.get(key)),
        set: (key, value) => {
          map.set(key, structuredClone(value))
        },
        delete: (key) => {
          map.delete(key)
        },
        entries: () => [...map].map(([key, value]) => ({ key, value: structuredClone(value) })),
        transaction: (work) => {
          const before = structuredClone(map)
          try {
            return work()
          } catch (error) {
            map.clear()
            for (const [k, v] of before) map.set(k, v)
            throw error
          }
        },
      }
    },
  }
}
function fixture(version = '1.0.0') {
  const storage = new MemoryStorage(),
    meta = metadata(),
    registry = new ServiceRegistry()
  const activations = new ProfileActivations(meta.namespace('@host', 'activation'))
  activations.publish([{ owner, revision: 'snapshot-one' }])
  const wakes = new ProfileWakeBindings(meta.namespace('@host', 'wakes'), activations)
  let now = 1000,
    resolvedActor = actor,
    enabled = true
  const handler = vi.fn(async (input: JsonValue, ctx: ServiceContext) => {
    ctx.store?.set('last', input)
    return input
  })
  const add = (name: string, overrides: Partial<ServiceDef> = {}, rowOwner = owner) =>
    registry.registerRow(
      {
        name,
        scope: 'profile',
        kind: 'effect',
        effectPolicy: policy,
        inputSchema: schema,
        outputSchema: schema,
        timeoutMs: 30000,
        maxResultBytes: 65536,
        handler,
        ...overrides,
      } as ServiceDef,
      {
        owner: rowOwner,
        packageId: rowOwner === owner ? '@acme/reports' : '@acme/notifications',
        integrity: 'snapshot-one',
        version,
        declaredCapabilities: { store: true, wake: true },
        signal: new AbortController().signal,
        assertAlive: () => {
          if (!enabled) throw new Error('disabled')
        },
        assertRunning() {},
        consume() {},
      },
    )
  add('reports.publish')
  add('reports.read', {
    kind: 'query',
    handler: async (input, ctx) => {
      expect(ctx.session).toBeUndefined()
      expect(ctx.childJobs).toBeUndefined()
      expect(ctx.sandbox).toBeUndefined()
      expect(ctx.scope).toMatchObject({ kind: 'profile', profileId: 'default' })
      expect(() => ctx.fs.write('file', new Uint8Array())).toThrow()
      expect(() => ctx.store?.set('escape', true)).toThrow()
      return input
    },
  })
  const audit = vi.fn()
  const changes = vi.fn()
  const make = (journalKey?: string, managed?: ProfileManagedResources) =>
    createProfileServiceRuntime({
      ...(journalKey ? { journalKey } : {}),
      ...(managed ? { managed } : {}),
      profileId: 'default',
      decisionsChanged: changes,
      registry,
      activations,
      storage,
      metadata: meta,
      wakes,
      log: logger,
      seams: fakeSeams({
        principals: {
          resolve: async (credential) => ({
            ...resolvedActor,
            id: credential === 'other' ? 'other' : resolvedActor.id,
            role: credential === 'agent' ? 'agent' : resolvedActor.role,
          }),
          authorize: async () => ({ effect: 'allow', decisionId: 'permit', reason: 'fixture' }),
        },
      }),
      authority: {
        resolve: async (credential) => {
          if (credential !== 'granted' && credential !== 'beta') throw new Error('No source authority')
          return {
            source: credential === 'beta' ? 'notice-panel' : 'report-panel',
            subjectCredential: 'human',
            grants: [
              'reports.publish',
              'reports.read',
              'reports.stop',
              'notice.publish',
              'wake.enqueue',
              'server.reconcile',
            ].map((name) => ({
              extension: credential === 'beta' ? 'plugin/fedcba9876543210' : owner,
              name,
              range: '*',
            })),
          }
        },
      },
      clock: () => now,
      signal: new AbortController().signal,
      networkAllow: [],
      audit,
    })
  const call = { extension: owner, service: 'reports.publish', operationId: 'one', input: { value: 1 } }
  return {
    storage,
    meta,
    registry,
    activations,
    wakes,
    handler,
    add,
    make,
    call,
    audit,
    changes,
    setActor: (value: Actor) => {
      resolvedActor = value
    },
    time: (value: number) => {
      now = value
    },
    disable: () => {
      enabled = false
      activations.publish([])
    },
  }
}
async function approve(
  runtime: ReturnType<typeof createProfileServiceRuntime>,
  option = 'allowed-once',
): Promise<DecisionSnapshot> {
  const snapshot = (await runtime.listDecisions('human'))[0]!
  await runtime.answerDecision(
    {
      handle: snapshot.handle,
      revision: snapshot.revision,
      commandId: `answer:${snapshot.handle.id}`,
      response: { option, value: null },
    },
    'human',
  )
  return snapshot
}

describe('current profile authority', () => {
  it.each(providerVersions)('serves %s queries with identity and mutation fences', async (version) => {
    const f = fixture(version),
      runtime = f.make()
    try {
      expect(
        await runtime.call({ extension: owner, service: 'reports.read', input: { value: 3 } }, 'granted'),
      ).toEqual({ output: { value: 3 } })
      for (const key of ['actor', 'role', 'profileId', 'approved', 'approval', 'owner', 'sessionId'])
        await expect(runtime.call({ ...f.call, [key]: true }, 'granted')).rejects.toMatchObject({
          data: { code: 'INVALID_PARAMS' },
        })
      await expect(
        runtime.call({ ...f.call, sessionReads: ['owned-session'] }, 'granted'),
      ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      await expect(runtime.call(f.call, 'forged')).rejects.toThrow()
      expect(f.handler).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })
  it('reuses durable AR1 approvals, consumes once with dispatch intent, and replays receipts after restart', async () => {
    const f = fixture()
    let runtime = f.make()
    try {
      const pending = (await runtime.call(f.call, 'granted')) as ProfileServiceReceipt
      expect(pending).toMatchObject({
        state: 'approval-required',
        decision: { sessionId: null, profileId: 'default' },
      })
      expect(f.changes.mock.calls).toEqual([
        [{ profile: 'default', principal: { id: actor.id, org: actor.org } }],
      ])
      f.changes.mockClear()
      expect(await runtime.call(f.call, 'granted')).toEqual(pending)
      expect(f.changes).not.toHaveBeenCalled()
      const listed = await runtime.listDecisionState('human')
      expect(listed.principal).toEqual({ id: actor.id, org: actor.org })
      const snapshot = listed.decisions[0]!
      expect(snapshot.request.spec.subject).toMatchObject({
        input: { value: 1 },
        preparedInput: { value: 1 },
        resourceRevision: null,
      })
      await expect(
        runtime.answerDecision(
          {
            handle: snapshot.handle,
            revision: snapshot.revision,
            commandId: 'spoof',
            response: { option: 'allowed-once', value: null },
          },
          'other',
        ),
      ).rejects.toThrow()
      expect(f.changes).not.toHaveBeenCalled()
      await runtime.close()
      runtime = f.make()
      expect((await runtime.listDecisions('human'))[0]?.handle).toEqual(snapshot.handle)
      f.changes.mockClear()
      await approve(runtime)
      expect(f.changes.mock.calls).toEqual([
        [{ profile: 'default', principal: { id: actor.id, org: actor.org } }],
      ])
      expect(await runtime.call(f.call, 'granted')).toMatchObject({
        state: 'completed',
        output: { value: 1 },
      })
      expect(f.handler.mock.calls[0]?.[1].admission?.approval?.answeredBy.id).toBe(actor.id)
      await runtime.close()
      runtime = f.make()
      expect(await runtime.call(f.call, 'granted')).toMatchObject({ state: 'completed' })
      expect(f.handler).toHaveBeenCalledTimes(1)
      const rows = await f.storage.scan('@profile/default', { limit: 100 })
      const consumed = rows.findIndex(
        (row) => row.type === 'decision/state' && (row.data as DecisionSnapshot).consumption !== null,
      )
      expect(consumed).toBeGreaterThan(0)
      expect(rows[consumed + 1]?.data).toMatchObject({ receipt: { state: 'running' } })
      expect(rows.some((row) => row.type === 'session/start')).toBe(false)
    } finally {
      await runtime.close()
    }
  })
  it('keeps report and notification fixtures in separate owners and approval subjects', async () => {
    const f = fixture(),
      beta = 'plugin/fedcba9876543210'
    f.add('notice.publish', {}, beta)
    f.activations.publish([
      { owner, revision: 'snapshot-one' },
      { owner: beta, revision: 'snapshot-one' },
    ])
    const runtime = f.make(),
      notification = { ...f.call, extension: beta, service: 'notice.publish', input: { value: 2 } }
    try {
      const report = (await runtime.call(f.call, 'granted')) as ProfileServiceReceipt
      const notice = (await runtime.call(notification, 'beta')) as ProfileServiceReceipt
      expect(report.decision?.id).not.toBe(notice.decision?.id)
      const pending = await runtime.listDecisions('human')
      expect(pending.map((value) => value.request.sourcePackage).sort()).toEqual([
        '@acme/notifications',
        '@acme/reports',
      ])
      await approve(runtime)
      expect(await runtime.call(notification, 'beta')).toMatchObject({ state: 'approval-required' })
      await expect(runtime.call(notification, 'granted')).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
      expect(await runtime.call(f.call, 'granted')).toMatchObject({ state: 'completed' })
      await approve(runtime)
      expect(await runtime.call(notification, 'beta')).toMatchObject({ state: 'completed' })
      expect(f.meta.namespace(owner, 'profile:default').get('last')).toEqual({ value: 1 })
      expect(f.meta.namespace(beta, 'profile:default').get('last')).toEqual({ value: 2 })
    } finally {
      await runtime.close()
    }
  })
  it('expires persisted profile approvals at the deadline without polling and cleans up on close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const f = fixture()
    let runtime = f.make()
    try {
      await runtime.call(f.call, 'granted')
      await runtime.close()
      f.changes.mockClear()
      runtime = f.make()
      await runtime.listDecisions('human')
      expect(f.changes).not.toHaveBeenCalled()
      f.time(86401001)
      await vi.advanceTimersByTimeAsync(86400000)
      expect(f.changes.mock.calls).toEqual([
        [{ profile: 'default', principal: { id: actor.id, org: actor.org } }],
      ])
      expect(await runtime.listDecisions('human')).toEqual([])
      await runtime.call({ ...f.call, operationId: 'after-expiry' }, 'granted')
      await runtime.close()
      f.changes.mockClear()
      f.time(172802000)
      await vi.advanceTimersByTimeAsync(86400000)
      expect(f.changes).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
      vi.useRealTimers()
    }
  })
  it('shares one profile writer while retained code containers close', async () => {
    const f = fixture(),
      first = f.make('shared-profile-fixture'),
      second = f.make('shared-profile-fixture')
    try {
      const pending = await first.call(f.call, 'granted')
      expect(f.changes.mock.calls).toEqual([
        [{ profile: 'default', principal: { id: actor.id, org: actor.org } }],
      ])
      expect((await second.listDecisions('human'))[0]?.handle).toEqual(
        'decision' in pending ? pending.decision : undefined,
      )
      await first.close()
      f.changes.mockClear()
      await approve(second)
      expect(f.changes.mock.calls).toEqual([
        [{ profile: 'default', principal: { id: actor.id, org: actor.org } }],
      ])
      expect(await second.call(f.call, 'granted')).toMatchObject({ state: 'completed' })
    } finally {
      await first.close()
      await second.close()
    }
  })
  it.each(['rejected', 'expired', 'changed-input', 'disabled'] as const)(
    'never dispatches a %s approval',
    async (reason) => {
      const f = fixture(),
        runtime = f.make()
      try {
        await runtime.call(f.call, 'granted')
        if (reason === 'expired') f.time(86401001)
        else if (reason === 'disabled') {
          f.activations.publish([])
          f.activations.publish([{ owner, revision: 'snapshot-one' }])
        } else await approve(runtime, reason === 'rejected' ? 'rejected' : 'allowed-once')
        if (reason === 'changed-input')
          await expect(runtime.call({ ...f.call, input: { value: 2 } }, 'granted')).rejects.toMatchObject({
            data: { code: 'ID_CONFLICT' },
          })
        else expect(await runtime.call(f.call, 'granted')).toMatchObject({ state: 'refused' })
        if (reason === 'disabled') await runtime.listDecisions('human')
        if (reason === 'expired' || reason === 'disabled') {
          expect(f.changes.mock.calls.length).toBeGreaterThan(1)
          for (const [detail] of f.changes.mock.calls)
            expect(detail).toEqual({ profile: 'default', principal: { id: actor.id, org: actor.org } })
        }
        expect(f.handler).not.toHaveBeenCalled()
      } finally {
        await runtime.close()
      }
    },
  )
  it('retains unknown dispatch outcomes after a missing receipt without repeating the effect', async () => {
    const f = fixture()
    let runtime = f.make()
    try {
      await runtime.call(f.call, 'granted')
      await approve(runtime)
      const original = f.storage.commit.bind(f.storage)
      const failure = vi.spyOn(f.storage, 'commit').mockImplementation(async (key, tx) => {
        if (
          tx.events.some(
            (event) =>
              event.type === 'x/host/profile-operation' &&
              (event.data as { receipt?: { state?: string } }).receipt?.state === 'completed',
          )
        )
          throw new Error('simulated crash before receipt')
        return original(key, tx)
      })
      expect(await runtime.call(f.call, 'granted')).toMatchObject({ state: 'unknown' })
      failure.mockRestore()
      await runtime.close()
      runtime = f.make()
      expect(await runtime.call(f.call, 'granted')).toMatchObject({ state: 'unknown' })
      expect(f.handler).toHaveBeenCalledTimes(1)
    } finally {
      await runtime.close()
    }
  })
  it('binds preparation revisions and rejects cancellation before dispatch', async () => {
    const f = fixture()
    let revision = 'one'
    f.add('notice.publish', {
      prepare: async (input, ctx) => {
        expect(() => ctx.store?.set('prepare-write', true)).toThrow()
        return { input, presentation: { target: 'report' }, resourceRevision: revision }
      },
    })
    const runtime = f.make(),
      params = { ...f.call, service: 'notice.publish' }
    try {
      await runtime.call(params, 'granted')
      await approve(runtime)
      revision = 'two'
      await expect(runtime.call(params, 'granted')).rejects.toMatchObject({ data: { code: 'ID_CONFLICT' } })
      await expect(runtime.call(f.call, 'granted', AbortSignal.abort())).rejects.toThrow()
      expect(f.handler).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
    }
  })
  it('keeps reviewed urgent effects independent of a long normal dispatch and deduplicates concurrent operations', async () => {
    const f = fixture()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.add('notice.publish', {
      handler: async (input) => {
        entered()
        await gate
        return input
      },
    })
    f.add('reports.stop', {
      priority: 'urgent',
      effectPolicy: { ...policy, isDestructive: false, requiresApproval: 'never' },
    })
    const runtime = f.make(),
      params = { ...f.call, service: 'notice.publish' }
    try {
      await runtime.call(params, 'granted')
      await approve(runtime)
      const normal = runtime.call(params, 'granted')
      await started
      expect(
        await runtime.call({ ...f.call, service: 'reports.stop', operationId: 'stop' }, 'granted'),
      ).toMatchObject({ state: 'completed' })
      release()
      await normal
      const duplicate = await Promise.all([runtime.call(params, 'granted'), runtime.call(params, 'granted')])
      expect(duplicate.every((row) => 'state' in row && row.state === 'completed')).toBe(true)
    } finally {
      release()
      await runtime.close()
    }
  })
  it('bounds control leases to the admitted actor, subject and activation', async () => {
    const f = fixture()
    f.add('notice.publish', { controlLeaseMs: 1000 })
    const runtime = f.make(),
      params = { ...f.call, service: 'notice.publish' }
    try {
      await runtime.call(params, 'granted')
      await expect(
        runtime.authorizeControl(
          { extension: owner, service: params.service, operationId: 'one' },
          'granted',
        ),
      ).rejects.toThrow()
      await approve(runtime)
      const receipt = (await runtime.call(params, 'granted')) as ProfileServiceReceipt
      expect(receipt.controlGrant).toMatchObject({ expiresAt: 2000 })
      expect(
        await runtime.authorizeControl(
          { extension: owner, service: params.service, operationId: 'one' },
          'granted',
        ),
      ).toMatchObject({ grantId: receipt.controlGrant?.grantId, actor: { id: actor.id } })
      f.setActor({ ...actor, attrs: { department: 'changed' } })
      await expect(
        runtime.authorizeControl(
          { extension: owner, service: params.service, operationId: 'one' },
          'granted',
        ),
      ).rejects.toThrow()
      f.setActor(actor)
      f.time(2000)
      await expect(
        runtime.authorizeControl(
          { extension: owner, service: params.service, operationId: 'one' },
          'granted',
        ),
      ).rejects.toThrow()
    } finally {
      await runtime.close()
    }
  })
  it.each(providerVersions.slice(0, 2))('fences %s owner state and bound wakes', async (version) => {
    const f = fixture(version),
      runtime = f.make()
    const first = ownedStore(f.meta.namespace(owner, 'state'), () => undefined, true)
    const second = ownedStore(f.meta.namespace('plugin/fedcba9876543210', 'state'), () => undefined, true)
    try {
      first.transaction(() => {
        first.set('accepted', true)
        first.set('outbox', { terminal: 'done' })
      })
      let active = true
      const admission = {
        verify: async () => {},
        assertActive() {
          if (!active) throw new Error('authority revoked')
        },
      }
      expect(() =>
        first.transaction(() => {
          first.set('accepted', false)
          active = false
        }, admission),
      ).toThrow('authority revoked')
      expect(first.get('accepted')).toBe(true)
      expect(() =>
        first.transaction(() => {
          first.set('accepted', false)
          try {
            first.transaction(() => first.set('escaped-admission', true), admission)
          } catch {
            /* A refused nested admission must also roll back the outer write. */
          }
        }),
      ).toThrow()
      expect(first.get('accepted')).toBe(true)
      expect(first.get('escaped-admission')).toBeUndefined()
      active = true
      expect(() =>
        first.transaction(() => {
          first.transaction(() => first.set('accepted', false), admission)
          // A later, still-valid capability must not replace the earlier one at root commit.
          first.transaction(() => first.set('escaped-second', true), {
            verify: async () => {},
            assertActive() {},
          })
          active = false
        }),
      ).toThrow('authority revoked')
      expect(first.get('accepted')).toBe(true)
      expect(first.get('escaped-second')).toBeUndefined()
      active = true
      first.transaction(() => first.transaction(() => first.set('accepted', true), admission))
      active = false
      first.transaction(() => first.set('accepted', true))
      expect(first.get('accepted')).toBe(true)
      expect(second.get('accepted')).toBeUndefined()
      expect(first.scan({ prefix: '', limit: 1 })).toMatchObject({
        rows: [{ key: 'accepted', value: true }],
        nextCursor: 'accepted',
      })
      expect(first.scan({ prefix: '', limit: 1, cursor: 'accepted' }).rows).toEqual([
        { key: 'outbox', value: { terminal: 'done' } },
      ])
      expect(() =>
        first.transaction(() => {
          first.set('accepted', false)
          throw new Error('rollback')
        }),
      ).toThrow()
      expect(first.get('accepted')).toBe(true)
      expect(() =>
        first.transaction(() => {
          try {
            first.transaction(() => {
              first.set('accepted', false)
              throw new Error('nested rollback')
            })
          } catch {
            /* An inner failure cannot be caught to commit a partial outer transaction. */
          }
        }),
      ).toThrow()
      expect(first.get('accepted')).toBe(true)
      expect(() =>
        first.transaction(async () => {
          first.set('accepted', false)
          await Promise.resolve()
          first.set('escaped', true)
        }),
      ).toThrow()
      await Promise.resolve()
      await Promise.resolve()
      expect(first.get('accepted')).toBe(true)
      expect(first.get('escaped')).toBeUndefined()
      const target = f.wakes.bind({
        producerOwner: owner,
        producerVersion: version,
        producerIntegrity: 'snapshot-one',
        profileId: 'default',
        sessionId: 'original',
        laneId: 'branch',
        generationId: 'gen',
        actorId: actor.id,
      })
      expect((await runtime.resolveWake(target.bindingId, 'granted')).binding).toMatchObject({
        sessionId: 'original',
        laneId: 'branch',
      })
      await expect(runtime.resolveWake(target.bindingId, 'forged')).rejects.toThrow()
      f.disable()
      expect((await runtime.resolveWake(target.bindingId, 'granted')).active).toBe(false)
      expect(() => f.wakes.require(target.bindingId)).toThrow()
    } finally {
      await runtime.close()
    }
  })
})

it.each([
  'approved',
  'upgraded',
  'upgraded-running',
  'upgraded-owner',
  'upgraded-dead',
  'upgraded-live',
  'stale-predecessor',
  'publishing',
  'rejected',
  'stale-marker',
  'stale-generation',
  'dead',
  'alive',
  'became-live',
  'live-at-dispatch',
  'probe-unavailable',
  'unauthorized',
] as const)('reconciles a managed singleton through native decisions: %s', async (scenario) => {
  const f = fixture(scenario === 'approved' ? '0.1.0-alpha.0' : '0.1.0')
  let releaseStartup!: () => void, enteredProbe!: () => void
  const startupGate = new Promise<void>((resolve) => {
    releaseStartup = resolve
  })
  const startupProbe = new Promise<void>((resolve) => {
    enteredProbe = resolve
  })
  const store = ownedStore(f.meta.namespace(owner, 'managed:server'), () => {}, true)
  store.set('managed-shutdown:server', true)
  // Boolean-only records deliberately have no identity.
  if (
    [
      'dead',
      'alive',
      'became-live',
      'live-at-dispatch',
      'probe-unavailable',
      'publishing',
      'upgraded-dead',
      'upgraded-live',
    ].includes(scenario)
  )
    store.set('managed-process:server', { pid: 42, startId: 'old' })
  store.set('operation:motion', { state: 'unknown' })
  let identity: 'dead' | 'alive' | 'unknown' =
    scenario === 'alive' || scenario === 'upgraded-live'
      ? 'alive'
      : scenario === 'upgraded-dead'
        ? 'dead'
        : 'unknown'
  let current = true
  const managed = new ProfileManagedResources(
    `native-reconcile-${scenario}`,
    () => {
      throw new Error('unused')
    },
    () => current,
    async (pid) => {
      if (pid === process.pid) return { state: 'alive', startId: 'self' }
      if (scenario === 'publishing') {
        enteredProbe()
        await startupGate
      }
      if (scenario === 'probe-unavailable') throw new Error('unavailable')
      return identity === 'alive'
        ? { state: 'alive', startId: 'old' }
        : identity === 'dead'
          ? { state: 'dead' }
          : { state: 'unknown', reason: 'unavailable' }
    },
  )
  const configSchema = { type: 'object', properties: {}, additionalProperties: false } as const
  const registration = {
    owner,
    packageId: '@acme/server',
    integrity: 'snapshot-one',
    revision: 'generation-one',
    store,
    assert() {},
    descriptor: {
      id: 'server',
      scope: 'profile',
      artifact: { kind: 'in-process' },
      apiVersion: '1.0.0',
      healthPath: '/health',
      listeners: [],
      requires: [],
      startupTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
    },
    definition: {
      id: 'server',
      configSchema,
      defaultConfig: {},
      async start(init) {
        init.onShutdown(async () => ({ state: 'settled' }))
        init.ready()
        return 'recovered'
      },
    },
  } satisfies Parameters<ProfileManagedResources['register']>[0]
  const handle = managed.register(registration)
  const previous = scenario.startsWith('upgraded')
    ? new ProfileManagedResources(
        `native-reconcile-${scenario}`,
        () => {
          throw new Error('unused')
        },
        undefined,
        async () => ({ state: 'unknown', reason: 'previous build cannot probe' }),
      )
    : undefined
  if (previous) {
    if (scenario === 'upgraded-running') store.set('managed-shutdown:server', false)
    const oldOwner = scenario === 'upgraded-owner' ? 'plugin/predecessor' : owner
    const oldStore =
      scenario === 'upgraded-owner'
        ? ownedStore(f.meta.namespace(oldOwner, 'managed:server'), () => {}, true)
        : store
    if (scenario === 'upgraded-owner') {
      store.delete('managed-shutdown:server')
      oldStore.set('managed-shutdown:server', true)
      oldStore.set('managed-process:server', { pid: 42, startId: 'old' })
    }
    const old = previous.register({
      ...registration,
      owner: oldOwner,
      store: oldStore,
      integrity: 'previous-snapshot',
      revision: 'previous-generation',
      ...(scenario === 'upgraded-running'
        ? {
            definition: {
              ...registration.definition,
              async start(init) {
                init.onShutdown(async () => {
                  store.delete('managed-process:server')
                  return { state: 'unknown' }
                })
                init.ready()
                return 'previous'
              },
            },
          }
        : {}),
    })
    await previous.publish()
    if (scenario === 'upgraded-running') expect(await old.get()).toBe('previous')
    else await expect(old.get()).rejects.toThrow()
    expect(previous.statuses('@acme/server')).toMatchObject([
      scenario === 'upgraded-running'
        ? { state: 'ready' }
        : { state: 'failed', code: 'shutdown-unconfirmed' },
    ])
  }
  registerManagedServices(
    'server',
    {
      register(def) {
        return f.add(def.name, def)
      },
    },
    handle,
    () => managed.settle(),
    configSchema,
  )
  const runtime = f.make(undefined, managed)
  const params = { extension: owner, service: 'server.reconcile', input: {}, operationId: 'reconcile-one' }
  if (scenario === 'live-at-dispatch') {
    const commit = f.storage.commit.bind(f.storage)
    vi.spyOn(f.storage, 'commit').mockImplementation(async (key, tx) => {
      const result = await commit(key, tx)
      // The OS becomes certain only after native dispatch intent has committed.
      if (
        tx.events.some(
          (event) =>
            event.type === 'x/host/profile-operation' &&
            (event.data as { receipt?: { state?: string } }).receipt?.state === 'running',
        )
      )
        identity = 'alive'
      return result
    })
  }

  try {
    const publication = managed.publish()
    let duringPublication: ReturnType<typeof runtime.call> | undefined
    if (scenario === 'publishing') {
      await startupProbe
      let settled = false
      duringPublication = runtime.call(params, 'granted')
      void duringPublication.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )
      await nextTurn()
      expect(settled).toBe(false)
      releaseStartup()
    }
    await publication
    if (scenario === 'upgraded-dead') {
      expect(await handle.get()).toBe('recovered')
      expect(await runtime.listDecisions('human')).toEqual([])
      expect(store.get('operation:motion')).toEqual({ state: 'unknown' })
      return
    }
    await expect(handle.get()).rejects.toThrow()
    if (scenario === 'dead') identity = 'dead'
    if (scenario === 'alive' || scenario === 'upgraded-live' || scenario === 'unauthorized') {
      await expect(runtime.call(params, scenario === 'unauthorized' ? 'forged' : 'granted')).rejects.toThrow()
      expect(await runtime.listDecisions('human')).toEqual([])
    } else {
      const first = await (duringPublication ?? runtime.call(params, 'granted'))
      if (scenario === 'dead') {
        expect(first).toMatchObject({ state: 'completed' })
        expect(await runtime.listDecisions('human')).toEqual([])
      } else {
        expect(first).toMatchObject({ state: 'approval-required' })
        const snapshot = (await runtime.listDecisions('human'))[0]
        if (!snapshot) throw new Error('native decision missing')
        expect(snapshot.request.spec.subject).toMatchObject({
          presentation: {
            resource: 'server',
            ownerPackage: '@acme/server',
            generation: 'generation-one',
            identityState: 'unknown',
          },
          resourceRevision: expect.any(String),
        })
        if (scenario.startsWith('upgraded'))
          expect(snapshot.request.spec.subject).toMatchObject({
            presentation: {
              predecessor: {
                owner: scenario === 'upgraded-owner' ? 'plugin/predecessor' : owner,
                activation: 'previous-generation',
                integrity: 'previous-snapshot',
              },
            },
          })
        await approve(runtime, scenario === 'rejected' ? 'rejected' : 'allowed-once')
        if (scenario === 'stale-predecessor')
          store.set('managed-predecessor:server', { owner, activation: 'another', integrity: 'changed' })
        if (scenario === 'stale-marker') store.set('managed-marker-revision:server', 'changed')
        if (scenario === 'stale-generation') current = false
        if (scenario === 'became-live') identity = 'alive'
        if (['stale-marker', 'stale-predecessor', 'stale-generation', 'became-live'].includes(scenario))
          await expect(runtime.call(params, 'granted')).rejects.toThrow()
        else
          expect(await runtime.call(params, 'granted')).toMatchObject({
            state:
              scenario === 'rejected' ? 'refused' : scenario === 'live-at-dispatch' ? 'unknown' : 'completed',
          })
      }
    }
    const recovered = [
      'approved',
      'upgraded',
      'upgraded-running',
      'upgraded-owner',
      'dead',
      'probe-unavailable',
      'publishing',
    ].includes(scenario)
    if (recovered) {
      expect(await handle.get()).toBe('recovered')
      expect(await runtime.call(params, 'granted')).toMatchObject({ state: 'completed' })
    } else {
      expect(managed.statuses('@acme/server')).toMatchObject([
        { state: 'failed', code: 'shutdown-unconfirmed' },
      ])
      expect(store.get('managed-shutdown:server')).toBe(true)
    }
    expect(store.get('operation:motion')).toEqual({ state: 'unknown' })
  } finally {
    releaseStartup()
    await runtime.close()
    await managed.close().catch(() => undefined)
    await previous?.close().catch(() => undefined)
  }
})
