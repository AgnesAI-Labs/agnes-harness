import { createServer } from 'node:net'
import type { BoundWakes, ProfileManagedDefinition } from '@agnes/extension-api'
import type { ProcessIdentity } from '@agnes/host-infrastructure/adapters/process-identity'
import type { JsonValue, ManagedServiceDescriptor } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { ProfileManagedResources } from '../src/profile/managed.js'
import { ownedStore } from '../src/profile/owned-store.js'

function storage() {
  const data = new Map<string, unknown>()
  const store = ownedStore(
    {
      get: (key) => structuredClone(data.get(key)),
      set: (key, value) => {
        data.set(key, structuredClone(value))
      },
      delete: (key) => {
        data.delete(key)
      },
      entries: () => [...data].map(([key, value]) => ({ key, value })),
      transaction: (fn) => fn(),
    },
    () => {},
    true,
  )
  return { data, store }
}

it('runs only the published resource, drains replacements, and refuses revival after unknown shutdown', async () => {
  const { data, store } = storage()
  const wakes: BoundWakes = {
    async enqueue() {
      throw new Error('unbound-target')
    },
    async read() {
      throw new Error('unbound-target')
    },
  }
  let current = true
  const one = new ProfileManagedResources(
      'synthetic-singleton',
      () => wakes,
      () => current,
    ),
    two = new ProfileManagedResources('synthetic-singleton', () => wakes)
  const descriptor: ManagedServiceDescriptor = {
    id: 'server',
    scope: 'profile',
    artifact: { kind: 'in-process' },
    healthPath: '/health',
    apiVersion: '1.0.0',
    listeners: [{ name: 'api', host: '127.0.0.1', port: 'auto' }],
    startupTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    requires: [],
  }
  let running = 0,
    peak = 0
  let unknown = false,
    failStart = true
  const definition: ProfileManagedDefinition<{ port: number }> = {
    id: 'server',
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    defaultConfig: {},
    async start(init) {
      const server = createServer()
      let listening = false
      init.onShutdown(async () => {
        if (listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()))
          running--
        }
        return { state: unknown ? 'unknown' : 'settled' }
      })
      if (failStart) throw new Error('synthetic-start-failure')
      const port = init.listeners.api!.port
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', resolve)
      })
      listening = true
      running++
      peak = Math.max(peak, running)
      init.ready()
      return { port }
    },
  }
  const input = {
    owner: 'plugin/synthetic',
    packageId: '@example/server',
    integrity: 'v1',
    revision: 'one',
    descriptor,
    definition,
    store,
    assert() {},
  }
  const first = one.register(input),
    staged = two.register({ ...input, revision: 'two' })
  try {
    await expect(staged.get()).rejects.toThrow()
    expect(running).toBe(0)
    await one.publish()
    await expect(first.get()).rejects.toThrow()
    expect(one.statuses('@example/server')).toMatchObject([{ state: 'failed', code: 'unavailable' }])
    failStart = false
    const retries = await Promise.allSettled([first.retry(), first.retry()])
    expect(retries.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await first.get()).port).toBeGreaterThan(0)
    expect(running).toBe(1)
    const originalPort = (await first.get()).port
    const sibling = one.register({
      ...input,
      descriptor: { ...descriptor, id: 'sibling', listeners: [] },
      definition: {
        ...definition,
        id: 'sibling',
        async start(init) {
          init.onShutdown(async () => ({ state: 'settled' }))
          init.ready()
          return { port: 0 }
        },
      },
    })
    await one.publish()
    expect((await first.get()).port).toBe(originalPort)
    sibling.release()
    await one.publish()
    expect((await first.get()).port).toBe(originalPort)
    current = false
    await one.publish()
    expect(one.statuses('@example/server')).toEqual([])
    await expect(first.get()).rejects.toThrow()
    current = true
    const publishing = one.publish()
    // Replace while the preceding publication is still installing its starting resource slot.
    await Promise.resolve()
    await two.publish()
    await publishing
    await expect(first.get()).rejects.toThrow()
    expect((await staged.get()).port).toBeGreaterThan(0)
    expect(peak).toBe(1)
    unknown = true
    staged.release()
    await expect(two.publish()).rejects.toThrow()
    expect(two.statuses('@example/server')).toMatchObject([{ state: 'failed', code: 'shutdown-unconfirmed' }])
    expect(data.get('managed-shutdown:server')).toBe(true)
  } finally {
    await one.close()
    await two.close().catch(() => undefined)
  }
})

it.each([
  ['retry', 'settled', false, undefined],
  ['reconcile', 'settled', true, undefined],
  ['toggle', 'settled', true, undefined],
  ['retoggle', 'settled', false, undefined],
  ['stale-decision', 'settled', false, undefined],
  ['unfinished-startup', 'settled', false, undefined],
  ['retry', 'unknown', false, undefined],
  ['retry', 'rejected', true, undefined],
  ['retry', 'settled', false, 'incarnation'],
  ['retry', 'settled', true, 'incarnation'],
  ['retry', 'settled', true, 'identity'],
] as const)(
  'allows %s only after confirmed late %s cleanup (separate stores: %s, changed fence: %s)',
  async (route, outcome, separate, changed) => {
    vi.useFakeTimers()
    const origin = storage()
    const destination = separate ? storage() : origin
    const owner = 'plugin/late-cleanup',
      packageId = '@example/late-cleanup'
    const managers: ProfileManagedResources[] = []
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => {
      release = resolve
    })
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve
    })
    const activate = (revision: string, store: typeof origin.store) => {
      const manager = new ProfileManagedResources(
        'synthetic-late-cleanup',
        () => ({
          async enqueue() {
            throw new Error('unused')
          },
          async read() {
            throw new Error('unused')
          },
        }),
        undefined,
        async (pid) =>
          pid === process.pid && route !== 'stale-decision'
            ? { state: 'alive', startId: 'worker:self' }
            : { state: 'unknown', reason: 'foreign owner' },
      )
      managers.push(manager)
      const handle = manager.register({
        owner,
        packageId,
        revision,
        integrity: revision,
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
          startupTimeoutMs: 5000,
          shutdownTimeoutMs: 5000,
        },
        definition: {
          id: 'server',
          configSchema: { type: 'object', properties: {}, additionalProperties: false },
          defaultConfig: {},
          async start(init) {
            init.onShutdown(async () => {
              if (revision === 'old') {
                await cleanup
                if (outcome === 'rejected') throw new Error('cleanup failed')
                return { state: outcome }
              }
              return { state: 'settled' }
            })
            if (revision === 'old' && route === 'unfinished-startup') await startup
            init.ready()
            return revision
          },
        },
      })
      return { manager, handle }
    }
    try {
      const old = activate('old', origin.store)
      await old.manager.publish()
      if (route === 'unfinished-startup') {
        await vi.advanceTimersByTimeAsync(10001)
        await expect(old.handle.get()).rejects.toThrow()
      } else expect(await old.handle.get()).toBe('old')
      let next = activate('new', destination.store)
      const switching = next.manager.publish()
      await vi.advanceTimersByTimeAsync(5001)
      await switching
      await expect(next.handle.get()).rejects.toThrow()
      expect(next.manager.statuses(packageId)).toMatchObject([
        { state: 'failed', code: 'shutdown-unconfirmed' },
      ])
      await expect(next.handle.retry()).rejects.toThrow()
      const recovery = next.manager.reconciliation(owner, 'server.reconcile')
      if (!recovery) throw new Error('Missing managed reconciliation service')
      const previousDecision = route === 'stale-decision' ? await recovery.prepare() : undefined
      destination.store.set('operation:motion', { state: 'unknown' })
      destination.store.set('managed-shutdown:other', true)
      if (changed === 'incarnation') destination.store.set('managed-incarnation:server', 'another-instance')
      if (changed === 'identity')
        destination.store.set('managed-process:server', { pid: 42, startId: 'foreign' })
      if (route === 'toggle' || route === 'retoggle') {
        next.handle.release()
        await next.manager.publish('disable')
        if (route === 'retoggle') {
          next = activate('pending-reenable', destination.store)
          await next.manager.publish()
          await expect(next.handle.get()).rejects.toThrow()
        }
      }
      release()
      await vi.advanceTimersByTimeAsync(0)
      const confirmed = outcome === 'settled' && changed === undefined && route !== 'unfinished-startup'
      if (confirmed) {
        expect(destination.store.get('managed-shutdown:server')).toBe(false)
        await expect(next.handle.get()).rejects.toThrow()
        if (route === 'retry' || route === 'retoggle') {
          const retries = await Promise.allSettled([next.handle.retry(), next.handle.retry()])
          expect(retries.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
          expect(await next.handle.get()).toBe(route === 'retoggle' ? 'pending-reenable' : 'new')
        } else if (route === 'reconcile' || route === 'stale-decision') {
          if (previousDecision) {
            await expect(
              next.handle.reconcile({
                admission: { prepared: previousDecision, approval: { answer: 'allow' } },
                signal: new AbortController().signal,
              } as never),
            ).rejects.toThrow()
          }
          const prepared = await recovery.prepare()
          expect(prepared.presentation).toMatchObject({
            cleanupConfirmed: true,
            identityState: route === 'stale-decision' ? 'unknown' : 'alive',
          })
          await next.handle.reconcile({
            admission: { prepared },
            signal: new AbortController().signal,
          } as never)
          expect(await next.handle.get()).toBe('new')
          await expect(
            next.handle.reconcile({
              admission: { prepared },
              signal: new AbortController().signal,
            } as never),
          ).rejects.toThrow()
        } else {
          const enabled = activate('enabled', destination.store)
          await enabled.manager.publish()
          expect(await enabled.handle.get()).toBe('enabled')
        }
        // A confirmation for the old instance must not clear its successor's active marker.
        expect(destination.store.get('managed-shutdown:server')).toBe(true)
      } else {
        expect(destination.store.get('managed-shutdown:server')).toBe(true)
        await expect(next.handle.retry()).rejects.toThrow()
      }
      expect(destination.store.get('operation:motion')).toEqual({ state: 'unknown' })
      expect(destination.store.get('managed-shutdown:other')).toBe(true)
    } finally {
      release()
      finishStartup()
      await vi.advanceTimersByTimeAsync(0)
      for (const manager of managers) await manager.close().catch(() => undefined)
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  },
)

// Synthetic OS snapshots exercise recovery without starting daemon/worker processes.
it.each([
  {
    name: 'confirmed clean stop',
    marker: false,
    owner: { pid: 42, startId: 'boot:old' },
    identity: { state: 'alive', startId: 'boot:old' },
    recover: true,
  },
  {
    name: 'dead worker after crash',
    marker: true,
    owner: { pid: 42, startId: 'boot:old' },
    identity: { state: 'dead' },
    recover: true,
  },
  {
    name: 'reused PID',
    marker: true,
    owner: { pid: 42, startId: 'boot:old' },
    identity: { state: 'alive', startId: 'boot:new' },
    recover: true,
  },
  {
    name: 'same live worker',
    marker: true,
    owner: { pid: 42, startId: 'boot:old' },
    identity: { state: 'alive', startId: 'boot:old' },
    recover: false,
  },
  {
    name: 'unverifiable identity',
    marker: true,
    owner: { pid: 42, startId: 'boot:old' },
    identity: { state: 'unknown', reason: 'probe denied' },
    recover: false,
  },
  { name: 'missing old identity', marker: true, owner: null, identity: { state: 'dead' }, recover: false },
  {
    name: 'missing start identity',
    marker: true,
    owner: { pid: 42, startId: null },
    identity: { state: 'dead' },
    recover: false,
  },
  {
    name: 'invalid PID',
    marker: true,
    owner: { pid: -1, startId: 'boot:old' },
    identity: { state: 'dead' },
    recover: false,
  },
  {
    name: 'malformed live identity',
    marker: true,
    owner: { pid: 42, startId: 'boot:old' },
    identity: { state: 'alive', startId: '' },
    recover: false,
  },
  {
    name: 'probe timeout',
    marker: true,
    owner: { pid: 42, startId: 'boot:old' },
    identity: null,
    recover: false,
  },
  {
    name: 'probe failure',
    marker: true,
    owner: { pid: 42, startId: 'boot:old' },
    identity: null,
    recover: false,
  },
] satisfies {
  name: string
  marker: boolean
  owner: JsonValue
  identity: ProcessIdentity | null
  recover: boolean
}[])(
  'reconciles resource liveness for $name without changing operation outcomes',
  async ({ name, marker, owner, identity, recover }) => {
    if (name === 'probe timeout') vi.useFakeTimers()
    const { store } = storage()
    store.set('managed-shutdown:server', marker)
    if (owner) store.set('managed-process:server', owner)
    store.set('operation:motion', { state: 'unknown' })
    const manager = () =>
      new ProfileManagedResources(
        'synthetic-recovery',
        () => ({
          async enqueue() {
            throw new Error('unused')
          },
          async read() {
            throw new Error('unused')
          },
        }),
        undefined,
        async (pid): Promise<ProcessIdentity> => {
          if (pid === process.pid) return { state: 'alive', startId: 'boot:self' }
          if (name === 'probe timeout') return new Promise(() => {})
          if (!identity) throw new Error('probe failed')
          return identity
        },
      )
    let shutdownFinished = false
    let released!: () => void
    const drain = new Promise<void>((resolve) => {
      released = resolve
    })
    const input = {
      owner: 'plugin/synthetic',
      packageId: '@example/server',
      integrity: 'one',
      revision: 'one',
      store,
      assert() {},
      descriptor: {
        id: 'server',
        scope: 'profile' as const,
        artifact: { kind: 'in-process' as const },
        healthPath: '/health',
        apiVersion: '1.0.0',
        listeners: [],
        requires: [],
        startupTimeoutMs: 1000,
        shutdownTimeoutMs: 1000,
      },
      definition: {
        id: 'server',
        configSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const },
        defaultConfig: {},
        async start(init: Parameters<ProfileManagedDefinition<JsonValue>['start']>[0]) {
          init.onShutdown(async () => {
            await drain
            shutdownFinished = true
            return { state: 'settled' }
          })
          init.ready()
          return 'ready'
        },
      },
    }
    const first = manager()
    const handle = first.register(input)
    let second: ProfileManagedResources | undefined
    try {
      await first.publish()
      if (name === 'probe timeout') await vi.advanceTimersByTimeAsync(1001)
      if (recover) {
        expect(await handle.get()).toBe('ready')
        expect(first.statuses(input.packageId)).toMatchObject([{ state: 'ready' }])
        expect(store.get('managed-process:server')).toEqual({ pid: process.pid, startId: 'boot:self' })
        const closing = first.close()
        await Promise.resolve()
        expect(shutdownFinished).toBe(false)
        expect(store.get('managed-shutdown:server')).toBe(true)
        released()
        await closing
        expect(shutdownFinished).toBe(true)
        expect(store.get('managed-shutdown:server')).toBe(false)
        second = manager()
        const restarted = second.register(input)
        await second.publish()
        expect(await restarted.get()).toBe('ready')
        expect(second.statuses(input.packageId)).toMatchObject([{ state: 'ready' }])
      } else {
        await expect(handle.get()).rejects.toThrow()
        expect(first.statuses(input.packageId)).toMatchObject([
          { state: 'failed', code: 'shutdown-unconfirmed' },
        ])
        await expect(handle.retry()).rejects.toThrow()
        expect(store.get('managed-shutdown:server')).toBe(true)
      }
      expect(store.get('operation:motion')).toEqual({ state: 'unknown' })
    } finally {
      released()
      await first.close().catch(() => undefined)
      await second?.close()
      if (!recover) expect(store.get('managed-shutdown:server')).toBe(true)
      if (name === 'probe timeout') {
        await vi.advanceTimersByTimeAsync(3000)
        vi.useRealTimers()
      }
    }
  },
)
