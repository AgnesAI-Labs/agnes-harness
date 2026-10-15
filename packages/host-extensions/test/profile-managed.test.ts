import { createServer } from 'node:net'
import type { BoundWakes, ProfileManagedDefinition } from '@agnes/extension-api'
import type { ManagedServiceDescriptor } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { ProfileManagedResources } from '../src/profile/managed.js'
import { ownedStore } from '../src/profile/owned-store.js'

it('runs only the published resource, drains replacements, and refuses revival after unknown shutdown', async () => {
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
    await one.publish()
    expect((await first.get()).port).toBeGreaterThan(0)
    await two.publish()
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
