import type { ToolContext } from '@agnes/extension-api'
import { createMhsTools } from '@agnes/mhs'
import type { Json } from '@agnes/mhs-device'
import { Hub, North, type OwnedStore } from '@agnes/mhs-hub'
import { afterEach, expect, it, vi } from 'vitest'
import { createMarsHubTransport } from '../src/hub-transport.js'
import { MarsRuntime } from '../src/runtime.js'
import { DEVICE_IDS, PLACES } from '../src/world.js'

// Synthetic persistence and admission ports; SDK, Hub, North and all seven tools are real.
function store(): OwnedStore {
  let rows = new Map<string, { value: Json; revision: string }>(),
    sequence = 0
  return {
    async transaction(fn) {
      const next = structuredClone(rows)
      const result = fn({
        get: (key) => next.get(key),
        put(key, value, expected) {
          if ((next.get(key)?.revision ?? null) !== expected) throw new Error('CAS_CONFLICT')
          next.set(key, { value: structuredClone(value), revision: String(++sequence) })
        },
        remove(key, expected) {
          if (next.get(key)?.revision !== expected) throw new Error('CAS_CONFLICT')
          next.delete(key)
        },
      })
      rows = next
      return result
    },
    async scan({ prefix, limit, cursor }) {
      const selected = [...rows]
        .filter(([key]) => key.startsWith(prefix) && (!cursor || key > cursor))
        .sort(([a], [b]) => (a < b ? -1 : 1))
      const page = selected.slice(0, limit).map(([key, row]) => ({ key, ...structuredClone(row) }))
      return { rows: page, ...(selected.length > page.length ? { nextCursor: page.at(-1)!.key } : {}) }
    },
  }
}
afterEach(() => vi.useRealTimers())
it('uses the actual seven-tool Hub contract, refuses unapproved motion and stops the fleet on revocation', async () => {
  vi.useFakeTimers()
  let current = true,
    approved = false,
    sequence = 0
  const hub = new Hub({
    store: store(),
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
    const call = tools.find((t) => t.name === 'call_device')!
    expect(call.meta).toMatchObject({ requiresApproval: 'always', replay: 'never' })
    const args = { device: 'rover-01', tool: 'drive_to', args: { ...PLACES.sample } }
    expect((await call.execute(args, ctx)).isError).toBe(true)
    expect(runtime.simulation.pose('rover-01')).toMatchObject(PLACES.dock)
    approved = true
    const moving = call.execute(args, ctx)
    await vi.advanceTimersByTimeAsync(500)
    const stop = tools.find((t) => t.name === 'stop_device')!
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
  }
})
it('refuses a missing reviewed link and refuses taking over an existing fleet', async () => {
  const hub = new Hub({
    store: store(),
    authority: {
      async assertActive() {},
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
  const denied = new MarsRuntime(
    createMarsHubTransport(hub, async () => {
      throw new Error('CAPABILITY_DENIED')
    }),
  )
  await expect(denied.start()).rejects.toThrow('CAPABILITY_DENIED')
  expect(hub.snapshot()).toEqual([])
  const first = new MarsRuntime(createMarsHubTransport(hub, async () => {}))
  const second = new MarsRuntime(createMarsHubTransport(hub, async () => {}))
  try {
    await first.start()
    await expect(second.start()).rejects.toThrow('example-device-already-owned')
    expect((await hub.list()).filter((d) => d.online)).toHaveLength(11)
    await first.reset()
    expect((await hub.list()).filter((d) => d.online)).toHaveLength(11)
  } finally {
    await second.stop()
    await first.stop()
    await hub.shutdown()
  }
})
