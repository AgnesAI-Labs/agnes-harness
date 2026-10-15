import { MemoryStorage } from '@agnes/core'
import { fakeSeams } from '@agnes/core/testkit'
import type {
  PersistenceMetadataNamespace,
  PersistenceMetadataPort,
  ServiceContext,
  ServiceDef,
} from '@agnes/extension-api'
import type { Actor, DecisionSnapshot, JsonValue, ProfileServiceReceipt } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { ServiceRegistry } from '../../src/ext-host/services.js'
import { ProfileActivations } from '../../src/profile/activation.js'
import { ownedStore } from '../../src/profile/owned-store.js'
import { createProfileServiceRuntime } from '../../src/profile/runtime.js'
import { ProfileWakeBindings } from '../../src/profile/wakes.js'

const owner = 'plugin/0123456789abcdef'
const actor: Actor = { id: 'operator', org: 'local', role: 'user', deptPath: [], attrs: {} }
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const policy = {
  isDestructive: true,
  isOpenWorld: true,
  requiresApproval: 'always',
  replay: 'never',
  approvalScopes: [],
} as const
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
function fixture() {
  const storage = new MemoryStorage(),
    meta = metadata(),
    registry = new ServiceRegistry()
  const activations = new ProfileActivations(meta.namespace('@host', 'activation'))
  activations.publish([{ owner, revision: 'snapshot-one' }])
  const wakes = new ProfileWakeBindings(meta.namespace('@host', 'wakes'), activations)
  let now = 1000,
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
        version: '1.0.0',
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
  const make = (journalKey?: string) =>
    createProfileServiceRuntime({
      ...(journalKey ? { journalKey } : {}),
      profileId: 'default',
      registry,
      activations,
      storage,
      metadata: meta,
      wakes,
      log: logger,
      seams: fakeSeams({
        principals: {
          resolve: async (credential) => ({
            ...actor,
            id: credential === 'other' ? 'other' : actor.id,
            role: credential === 'agent' ? 'agent' : 'user',
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
            grants: ['reports.publish', 'reports.read', 'reports.stop', 'notice.publish', 'wake.enqueue'].map(
              (name) => ({
                extension: credential === 'beta' ? 'plugin/fedcba9876543210' : owner,
                name,
                range: '*',
              }),
            ),
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
  it('serves a sessionless report query while refusing forged identity and mutation authority', async () => {
    const f = fixture(),
      runtime = f.make()
    try {
      expect(
        await runtime.call({ extension: owner, service: 'reports.read', input: { value: 3 } }, 'granted'),
      ).toEqual({ output: { value: 3 } })
      for (const key of ['actor', 'role', 'profileId', 'approved', 'approval', 'owner', 'sessionId'])
        await expect(runtime.call({ ...f.call, [key]: true }, 'granted')).rejects.toMatchObject({
          data: { code: 'INVALID_PARAMS' },
        })
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
      expect(await runtime.call(f.call, 'granted')).toEqual(pending)
      const snapshot = (await runtime.listDecisions('human'))[0]!
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
      await runtime.close()
      runtime = f.make()
      expect((await runtime.listDecisions('human'))[0]?.handle).toEqual(snapshot.handle)
      await approve(runtime)
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
  it('shares one profile writer while retained code containers close', async () => {
    const f = fixture(),
      first = f.make('shared-profile-fixture'),
      second = f.make('shared-profile-fixture')
    try {
      const pending = await first.call(f.call, 'granted')
      expect((await second.listDecisions('human'))[0]?.handle).toEqual(
        'decision' in pending ? pending.decision : undefined,
      )
      await first.close()
      await approve(second)
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
  it('isolates and rolls back owner state and requires bound producer authority for wakes', async () => {
    const f = fixture(),
      runtime = f.make()
    const first = ownedStore(f.meta.namespace(owner, 'state'), () => undefined, true)
    const second = ownedStore(f.meta.namespace('plugin/fedcba9876543210', 'state'), () => undefined, true)
    try {
      first.transaction(() => {
        first.set('accepted', true)
        first.set('outbox', { terminal: 'done' })
      })
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
