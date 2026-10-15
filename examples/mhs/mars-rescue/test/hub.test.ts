import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ToolContext } from '@agnes/extension-api'
import { createMhsTools, startManagedMhsHub } from '@agnes/mhs'
import { Hub, North } from '@agnes/mhs-hub'
import { createManagedServiceRuntime } from '@agnes/sdk/managed-service'
import { createOwnedStore } from '@agnes/sdk/owned-store'
import { afterEach, expect, it, vi } from 'vitest'
import { createMarsHubTransport } from '../src/hub-transport.js'
import { MarsRuntime } from '../src/runtime.js'
import { DEVICE_IDS, PLACES } from '../src/world.js'

// Only admission/wake identities are synthetic; storage, SDK, Hub and tools are real.
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('no-port')
  return address.port
}
afterEach(() => vi.useRealTimers())
it('uses the actual seven-tool Hub contract, refuses unapproved motion and stops the fleet on revocation', async () => {
  vi.useFakeTimers()
  let current = true,
    approved = false,
    sequence = 0
  const database = new DatabaseSync(':memory:')
  const hub = new Hub({
    store: createOwnedStore(database, 'mars'),
    authority: {
      async assertActive() {
        if (!current) throw new Error('revoked')
      },
      async admit(_subject, proof) {
        if (proof !== 'synthetic-approved') throw new Error('approval-required')
      },
    },
    wakes: {
      async enqueue() {
        return { wakeId: 'synthetic-wake', state: 'queued' }
      },
    },
  })
  await hub.recover()
  const parent = new AbortController()
  const runtime = new MarsRuntime(
    createMarsHubTransport(hub, async () => {
      parent.signal.throwIfAborted()
      if (!current) throw new Error('reviewed-link-revoked')
    }),
  )
  try {
    await runtime.start()
    expect((await hub.list()).map((d) => d.id)).toEqual(DEVICE_IDS)
    const tools = createMhsTools({
      north: new North(hub),
      async invocation() {
        return {
          operationId: `mars-tool-${++sequence}`,
          context: approved ? 'synthetic-approved' : 'refused',
          sessionId: 'rescue-session',
          laneId: 'main',
        }
      },
      async bindWake() {
        return { bindingId: 'rescue-session/main' }
      },
    })
    expect(tools.map((t) => t.name)).toEqual([
      'list_devices',
      'read_device',
      'call_device',
      'set_device',
      'stop_device',
      'watch_device',
      'unwatch_device',
    ])
    const ctx = { signal: new AbortController().signal, timeoutMs: 50_000 } as ToolContext
    const call = tools.find((t) => t.name === 'call_device')
    if (!call) throw new Error('missing-call-device')
    expect(call.meta).toMatchObject({ requiresApproval: 'always', replay: 'never' })
    const args = { device: 'rover-01', tool: 'drive_to', args: { ...PLACES.sample } }
    expect((await call.execute(args, ctx)).isError).toBe(true)
    expect(runtime.simulation.pose('rover-01')).toMatchObject(PLACES.dock)
    approved = true
    const moving = call.execute(args, ctx)
    await vi.advanceTimersByTimeAsync(500)
    const stop = tools.find((t) => t.name === 'stop_device')
    if (!stop) throw new Error('missing-stop-device')
    await stop.execute({}, ctx)
    expect((await moving).isError).toBe(true)
    const at = { ...runtime.simulation.pose('rover-01') }
    await vi.advanceTimersByTimeAsync(100)
    expect(runtime.simulation.pose('rover-01')).toEqual(at)
    current = false
    parent.abort()
    await runtime.stop()
    expect(hub.snapshot().every((d) => !d.online)).toBe(true)
    await expect(hub.list()).rejects.toThrow('revoked')
    expect(runtime.snapshot().online).toEqual([])
  } finally {
    await runtime.stop()
    await hub.shutdown()
    database.close()
  }
})
it('joins the real managed Hub, refuses duplicate fleets, resets in place and parks on parent shutdown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agh-mars-managed-'))
  const [port, devicePort] = await Promise.all([freePort(), freePort()])
  const managed = await createManagedServiceRuntime({
    port,
    initialization: {
      instanceId: 'mars-parent',
      incarnation: 'synthetic-mars-proof',
      scopeId: 'mars-profile',
      apiVersion: '1.0.0',
      namespace: 'mhs',
      storePath: join(directory, 'owned.db'),
      listeners: { device: { host: '127.0.0.1', port: devicePort } },
    },
  })
  let parent: Awaited<ReturnType<typeof startManagedMhsHub>> | undefined
  let first: MarsRuntime | undefined, second: MarsRuntime | undefined
  try {
    parent = await startManagedMhsHub(managed, {
      authority: {
        async assertActive() {
          managed.signal.throwIfAborted()
        },
        async admit() {
          throw new Error('denied')
        },
      },
      wakes: {
        async enqueue() {
          return { wakeId: 'w', state: 'queued' }
        },
      },
    })
    const hub = parent.north.hub
    const denied = new MarsRuntime(
      createMarsHubTransport(hub, async () => {
        throw new Error('CAPABILITY_DENIED')
      }),
    )
    await expect(denied.start()).rejects.toThrow('CAPABILITY_DENIED')
    expect(hub.snapshot()).toEqual([])
    const current = async () => managed.signal.throwIfAborted()
    first = new MarsRuntime(createMarsHubTransport(hub, current))
    second = new MarsRuntime(createMarsHubTransport(hub, current))
    await first.start()
    await expect(second.start()).rejects.toThrow('example-device-already-owned')
    expect(await parent.north.query('devices', {})).toHaveLength(11)
    await first.reset()
    expect(hub.snapshot().filter((d) => d.online)).toHaveLength(11)
    expect((await managed.store.scan({ prefix: 'format', limit: 1 })).rows[0]?.value).toBe(1)
    const response = await fetch(`http://127.0.0.1:${port}/_agnes/managed/shutdown`, {
      method: 'POST',
      headers: { 'x-agnes-incarnation': 'synthetic-mars-proof' },
      body: JSON.stringify({ reason: 'disable' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'settled' })
    await vi.waitFor(() => {
      expect(hub.snapshot().every((d) => !d.online)).toBe(true)
      expect(first?.snapshot()).toMatchObject({ status: 'unavailable', online: [] })
    })
  } finally {
    await second?.stop()
    await first?.stop()
    await parent?.stop()
    await managed.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
