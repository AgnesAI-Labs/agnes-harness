import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverBoundWake } from '@agnes/daemon-foundation/jobs/bound-wakes'
import type { ToolContext } from '@agnes/extension-api'
import { createMhsTools, startManagedMhsHub } from '@agnes/mhs'
import { digest, Hub, North } from '@agnes/mhs-hub'
import { createManagedServiceRuntime } from '@agnes/sdk/managed-service'
import { afterEach, expect, it, vi } from 'vitest'
import { createMarsHubTransport } from '../src/hub-transport.js'
import { MarsRuntime } from '../src/runtime.js'
import { DEVICE_IDS, PLACES } from '../src/world.js'
import { nativeHarness } from './native-harness.js'

// Account/session facts are synthetic; native approval, storage, wake queue, SDK and Hub are real.
async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('no-port')
  return address.port
}
afterEach(() => vi.useRealTimers())
it('runs Mars through real native AR1, owner storage and durable original-session wakes', async () => {
  vi.useFakeTimers()
  const native = await nativeHarness()
  const hub = new Hub({ store: native.store, authority: native.adapter.authority, wakes: native.wakes })
  await hub.recover()
  const services = native.attach(hub)
  const runtime = new MarsRuntime(createMarsHubTransport(hub, native.current))
  let sequence = 0
  try {
    await runtime.start()
    const tools = createMhsTools({
      north: new North(hub),
      invocation: async () => ({
        operationId: `mars-tool-${++sequence}`,
        context: null,
        sessionId: 'rescue-session',
        laneId: 'main',
      }),
      bindWake: async () => native.target(),
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
    expect((await hub.list()).map((d) => d.id)).toEqual(DEVICE_IDS)
    const ctx = { signal: new AbortController().signal, timeoutMs: 50_000 } as ToolContext
    const call = tools.find((t) => t.name === 'call_device')!
    expect(call.meta).toMatchObject({ requiresApproval: 'always', replay: 'never' })
    const args = { device: 'rover-01', tool: 'drive_to', args: { ...PLACES.sample } }
    // A direct session connector without consumed native admission must be refused.
    expect((await call.execute(args, ctx)).isError).toBe(true)
    const request = {
      extension: native.owner,
      service: 'mhs.call',
      operationId: 'native-refused-motion',
      input: args,
    }
    expect(await services.call(request, native.credential)).toMatchObject({ state: 'approval-required' })
    expect(runtime.simulation.pose('rover-01')).toMatchObject(PLACES.dock)
    await native.answer('rejected')
    expect(await services.call(request, native.credential)).toMatchObject({ state: 'refused' })
    expect(runtime.simulation.pose('rover-01')).toMatchObject(PLACES.dock)
    const moving = { ...request, operationId: 'native-motion' }
    expect(await services.call(moving, native.credential)).toMatchObject({ state: 'approval-required' })
    const approval = await native.answer('allowed-once')
    expect(approval.request.spec.subject).toMatchObject({
      presentation: { device: 'rover-01', action: 'call', input: { tool: 'drive_to', args: PLACES.sample } },
    })
    expect(await services.call(moving, native.credential)).toMatchObject({ state: 'completed' })
    await vi.advanceTimersByTimeAsync(500)
    expect(runtime.simulation.pose('rover-01')).not.toMatchObject(PLACES.dock)
    expect(
      await services.call(
        { extension: native.owner, service: 'mhs.stop', operationId: 'native-stop', input: {} },
        native.credential,
      ),
    ).toMatchObject({ state: 'completed', output: { state: 'settled' } })
    expect(await hub.waitOperation('native-motion', ctx.signal, 100)).toMatchObject({
      outcome: { status: 'interrupted' },
    })
    const at = { ...runtime.simulation.pose('rover-01') }
    await vi.advanceTimersByTimeAsync(100)
    expect(runtime.simulation.pose('rover-01')).toEqual(at)
    const watch = tools.find((t) => t.name === 'watch_device')!
    const watched = await watch.execute(
      { device: 'power-01', until: { state: 'production', lt: 1 }, timeout: 30 },
      ctx,
    )
    expect(watched.isError).not.toBe(true)
    const outcome = watched.structured
    if (
      !outcome ||
      typeof outcome !== 'object' ||
      Array.isArray(outcome) ||
      !('watch' in outcome) ||
      typeof outcome.watch !== 'string'
    )
      throw new Error('missing-watch-id')
    runtime.simulation.device('power-01').update({ production: 0 })
    await hub.watches.tick()
    const jobs = native.repo().claimDue(Date.now(), 'synthetic-worker', 1000, 10)
    expect(jobs).toHaveLength(1)
    const job = jobs[0]!
    expect(job.sessionKey).toBe('rescue-session')
    if (!('pluginNotification' in job.payload)) throw new Error('missing-bound-wake')
    const notification = job.payload.pluginNotification
    expect(native.bindings.require(notification.bindingId)).toMatchObject({
      sessionId: 'rescue-session',
      laneId: 'main',
      generationId: 'synthetic-rescue-generation',
    })
    const requeued = await native.makeWakes().enqueue(
      {
        target: { bindingId: notification.bindingId },
        idempotencyKey: `mhs/${digest(outcome.watch)}/terminal`,
        event: notification.event,
      },
      native.credential,
    )
    expect(requeued).toMatchObject({ wakeId: job.idempotencyKey, state: 'queued' })
    expect(await native.queue.read(job.idempotencyKey, native.credential)).toMatchObject({ state: 'queued' })
    await expect(native.queue.read(job.idempotencyKey, {})).rejects.toThrow('foreign-credential')
    await runtime.stop()
    native.activations.publish([])
    await expect(services.call(moving, native.credential)).rejects.toThrow()
    expect(() => native.bindings.require(notification.bindingId)).toThrow()
    expect(
      await deliverBoundWake(job, ctx.signal, {
        requireTarget: async (id) => services.requireWake(id),
        deliver: async () => {
          throw new Error('revoked-target-must-not-deliver')
        },
      }),
    ).toMatchObject({ reason: 'refused', code: 'TARGET_REVOKED' })
    expect(hub.snapshot().every((d) => !d.online)).toBe(true)
  } finally {
    await runtime.stop()
    await hub.shutdown().catch(() => {})
    await native.close()
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
  const native = await nativeHarness(managed.signal)
  let parent: Awaited<ReturnType<typeof startManagedMhsHub>> | undefined
  let first: MarsRuntime | undefined, second: MarsRuntime | undefined
  try {
    parent = await startManagedMhsHub(managed, { authority: native.adapter.authority, wakes: native.wakes })
    const hub = parent.north.hub
    native.attach(hub)
    const denied = new MarsRuntime(
      createMarsHubTransport(hub, async () => {
        await native.current()
        native.activations.require('plugin/0000000000000000', 'not-reviewed')
      }),
    )
    await expect(denied.start()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(hub.snapshot()).toEqual([])
    const current = native.current
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
    await native.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
