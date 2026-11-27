import type { BoundWakes, ProfileManagedDefinition } from '@agnes/extension-api'
import type { ManagedServiceDescriptor } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { FAILED_RESTART_BACKOFF_MS, ProfileManagedResources } from '../src/profile/managed.js'
import { ownedStore } from '../src/profile/owned-store.js'

const wakes: BoundWakes = {
  async enqueue() {
    throw new Error('unbound')
  },
  async read() {
    throw new Error('unbound')
  },
}
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined)
  vi.useRealTimers()
})

function storage() {
  const data = new Map<string, unknown>()
  return ownedStore(
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
}

function descriptor(id: string): ManagedServiceDescriptor {
  return {
    id,
    scope: 'profile',
    artifact: { kind: 'in-process' },
    healthPath: '/health',
    apiVersion: '1.0.0',
    listeners: [],
    startupTimeoutMs: 5000,
    shutdownTimeoutMs: 5000,
    requires: [],
  }
}

/** A service that counts its live instances; `plan(n)` decides how its n-th start behaves. */
function service(id: string, plan: (n: number) => 'fail' | Promise<void> | undefined = () => undefined) {
  const counts = { starts: 0, running: 0, peak: 0 }
  const definition: ProfileManagedDefinition<number> = {
    id,
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    defaultConfig: {},
    async start(init) {
      const n = ++counts.starts
      let up = false
      init.onShutdown(async () => {
        if (up) counts.running--
        up = false
        return { state: 'settled' }
      })
      const step = plan(n)
      if (step === 'fail') throw new Error('synthetic start failure')
      await step
      up = true
      counts.running++
      counts.peak = Math.max(counts.peak, counts.running)
      init.ready()
      return n
    },
  }
  return { counts, definition }
}

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let keys = 0
function manager(current?: (owner: string) => boolean) {
  const managed = new ProfileManagedResources(
    `managed-restart-${++keys}`,
    () => wakes,
    current ? (owner) => current(owner) : undefined,
  )
  closers.push(() => managed.close())
  const register = (
    packageId: string,
    definition: ProfileManagedDefinition<number>,
    assert: () => void = () => {},
  ) =>
    managed.register({
      owner: `plugin/${packageId}`,
      packageId,
      integrity: 'v1',
      revision: 'one',
      descriptor: descriptor(definition.id),
      definition,
      store: storage(),
      assert,
    })
  return { managed, register }
}

const states = (managed: ProfileManagedResources, packageId: string) =>
  managed.statuses(packageId).map((row) => row.state)

// A retry installs its instance one step after it reserves the failed slot. A publication issued in between
// (a reconcile, a row change) used to retire the reserved slot and start a twin, or drop the retry's
// instance from tracking. Each case issues the publication right after the retry, in that window.
it('keeps a failed slot that a retry reserved when a same-stamp publication races the retry', async () => {
  const flaky = service('flaky', (n) => (n === 1 ? 'fail' : undefined))
  const other = service('other')
  const { managed, register } = manager()
  const handle = register('@example/flaky', flaky.definition)
  register('@example/other', other.definition)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + FAILED_RESTART_BACKOFF_MS)
  const retry = handle.retry()
  const publication = managed.publish()
  await Promise.all([retry, publication])
  expect(flaky.counts).toMatchObject({ starts: 2, running: 1, peak: 1 })
  await expect(handle.get()).resolves.toBe(2)
  expect(states(managed, '@example/other')).toEqual(['ready'])
  // Every instance is tracked: closing the manager stops all of them.
  await managed.close()
  expect([flaky.counts.running, other.counts.running]).toEqual([0, 0])
})

it('tracks the instance a retry installs in a slot that a pending publication keeps', async () => {
  const flaky = service('flaky', (n) => (n === 1 ? 'fail' : undefined))
  const { managed, register } = manager()
  const handle = register('@example/flaky', flaky.definition)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + FAILED_RESTART_BACKOFF_MS)
  // Another definition changes the stamp: this publication keeps the reserved slot and drains after the
  // retry has installed its instance there.
  const retry = handle.retry()
  register('@example/third', service('third').definition)
  const publication = managed.publish()
  await Promise.all([retry, publication])
  expect(flaky.counts).toMatchObject({ starts: 2, running: 1, peak: 1 })
  await expect(handle.get()).resolves.toBe(2)
  await managed.close()
  expect(flaky.counts.running).toBe(0)
})

it('stops a retry instance whose slot a racing publication retired, and leaves other packages tracked', async () => {
  const flaky = service('flaky', (n) => (n === 1 ? 'fail' : undefined))
  const other = service('other')
  let flakyCurrent = true
  const { managed, register } = manager((owner) => owner !== 'plugin/@example/flaky' || flakyCurrent)
  const handle = register('@example/flaky', flaky.definition)
  const otherHandle = register('@example/other', other.definition)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  const retry = handle.retry()
  // The service stops being current: the publication retires the slot the retry reserved.
  flakyCurrent = false
  const publication = managed.publish()
  await expect(retry).rejects.toThrow()
  await publication
  expect(flaky.counts.running).toBe(0)
  expect(managed.statuses('@example/flaky')).toEqual([])
  await expect(otherHandle.get()).resolves.toBe(1)
  expect(states(managed, '@example/other')).toEqual(['ready'])
  await managed.close()
  expect(other.counts.running).toBe(0)
})

it('refuses a retry of a slot that a pending publication already retired', async () => {
  const gate = deferred()
  const flaky = service('flaky', (n) => (n === 1 ? 'fail' : undefined))
  const slow = service('slow', () => gate.promise)
  const { managed, register } = manager()
  const handle = register('@example/flaky', flaky.definition)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + FAILED_RESTART_BACKOFF_MS)
  // The first publication's drain is held; the second retires the failed slot and waits on that drain.
  register('@example/slow', slow.definition)
  const first = managed.publish()
  const second = managed.publish()
  await expect(handle.retry()).rejects.toThrow()
  gate.resolve()
  await Promise.allSettled([first, second])
  // The refused retry started nothing; the publication started the one instance.
  await expect(handle.get()).resolves.toBe(2)
  expect(flaky.counts).toMatchObject({ starts: 2, running: 1, peak: 1 })
  await managed.close()
  expect(flaky.counts.running).toBe(0)
})

it('puts the slot back when a retry cannot start, so a later retry may start it', async () => {
  const flaky = service('flaky', (n) => (n === 1 ? 'fail' : undefined))
  // Armed, the second check (the one inside the retry's start, after the slot was reserved) refuses.
  let armed = false,
    checks = 0
  const { managed, register } = manager()
  const handle = register('@example/flaky', flaky.definition, () => {
    if (armed && ++checks === 2) throw new Error('row no longer current')
  })
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  armed = true
  await expect(handle.retry()).rejects.toThrow('row no longer current')
  armed = false
  expect(managed.statuses('@example/flaky')).toMatchObject([{ state: 'failed', code: 'unavailable' }])
  await handle.retry()
  await expect(handle.get()).resolves.toBe(2)
})

it('does not restart a failed service within the backoff after its failure, then once per publication', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const flaky = service('flaky', (n) => (n <= 2 ? 'fail' : undefined))
  const { managed, register } = manager()
  const handle = register('@example/flaky', flaky.definition)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  expect(flaky.counts.starts).toBe(1)
  // Publications inside the backoff leave the failed service alone.
  vi.setSystemTime(Date.now() + FAILED_RESTART_BACKOFF_MS - 1000)
  await managed.publish()
  register('@example/other', service('other').definition)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  expect(flaky.counts.starts).toBe(1)
  expect(managed.statuses('@example/flaky')).toMatchObject([{ state: 'failed', code: 'unavailable' }])
  // After it, one publication makes one attempt; that failure starts a new backoff.
  vi.setSystemTime(Date.now() + 1001)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  expect(flaky.counts.starts).toBe(2)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  expect(flaky.counts.starts).toBe(2)
  vi.setSystemTime(Date.now() + FAILED_RESTART_BACKOFF_MS)
  await managed.publish()
  await expect(handle.get()).resolves.toBe(3)
  expect(states(managed, '@example/flaky')).toEqual(['ready'])
})

it('lets a forced publication and a retry start a failed service inside the backoff', async () => {
  const flaky = service('flaky', (n) => (n <= 2 ? 'fail' : undefined))
  const { managed, register } = manager()
  const handle = register('@example/flaky', flaky.definition)
  await managed.publish()
  await expect(handle.get()).rejects.toThrow()
  await managed.publish('upgrade', true)
  await expect(handle.get()).rejects.toThrow()
  expect(flaky.counts.starts).toBe(2)
  await handle.retry()
  await expect(handle.get()).resolves.toBe(3)
})
