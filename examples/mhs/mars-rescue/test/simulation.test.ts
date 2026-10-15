import type { Json, Outcome } from '@agnes/mhs-device'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type MarsConnection, MarsRuntime } from '../src/runtime.js'
import { MarsSimulation } from '../src/simulation.js'
import { BASE_MAP, DEVICE_IDS, type DeviceId, OBSTACLES, PLACES, route } from '../src/world.js'

afterEach(() => vi.useRealTimers())
async function run(
  sim: MarsSimulation,
  id: DeviceId,
  tool: string,
  args: Record<string, Json> = {},
): Promise<Outcome> {
  const call = sim.device(id).call(crypto.randomUUID(), tool, args)
  expect(call.accepted).toBe(true)
  let result: Outcome | undefined
  void call.result!.then((r) => {
    result = r
  })
  for (let i = 0; i < 1000 && !result; i++) {
    sim.tick(0.2)
    await vi.advanceTimersByTimeAsync(1)
  }
  expect(result).toBeDefined()
  return result!
}
describe('Mars base simulation', () => {
  it('declares eleven unique, constrained SDK devices in the same map frame', () => {
    const sim = new MarsSimulation()
    expect([...sim.devices.keys()]).toEqual(DEVICE_IDS)
    expect(new Set(BASE_MAP.places.map((p) => p.id)).size).toBe(BASE_MAP.places.length)
    for (const device of sim.devices.values()) {
      expect(device.description.placement?.map).toBe(BASE_MAP.id)
      expect(device.description.device.name).toContain('simulation')
      expect(device.call('bad', 'unknown', {}).accepted).toBe(false)
    }
    expect(sim.device('rover-01').call('bad', 'drive_to', { x: Infinity, y: 0 }).accepted).toBe(false)
    expect(sim.device('monolith-01').set({ humor: 200, honesty: 0 }).values).toEqual({
      humor: 100,
      honesty: 0,
    })
  })
  it('completes rescue with observable suit and airlock facts, and refuses unsafe pressure', async () => {
    vi.useFakeTimers()
    const sim = new MarsSimulation()
    expect(await run(sim, 'airlock-01', 'open_outer')).toMatchObject({ status: 'error' })
    expect(await run(sim, 'hopper-01', 'take_off', { alt: 10 })).toMatchObject({ status: 'done' })
    expect(await run(sim, 'hopper-01', 'survey', { area: 'west field' })).toMatchObject({
      status: 'done',
      data: { astronaut: { ...PLACES.field } },
    })
    expect(await run(sim, 'monolith-01', 'go_to', { ...PLACES.field, gait: 'walk' })).toMatchObject({
      status: 'done',
    })
    expect(await run(sim, 'monolith-01', 'carry', { target: 'suit-01' })).toMatchObject({ status: 'done' })
    expect(await run(sim, 'monolith-01', 'go_to', { ...PLACES.airlock, gait: 'walk' })).toMatchObject({
      status: 'done',
    })
    sim.tick(0.1)
    expect(await run(sim, 'monolith-01', 'put_down')).toMatchObject({ status: 'done' })
    await run(sim, 'habitat-01', 'set_mode', { mode: 'medical' })
    await run(sim, 'airlock-01', 'cycle_in')
    expect(sim.state('suit-01')).toMatchObject({ rescued: true, o2_left: 100 })
    expect(sim.state('habitat-01').mode).toBe('medical')
    expect(sim.state('airlock-01')).toMatchObject({ pressure: 101, outer: 'closed', inner: 'closed' })
    await sim.stop()
  })
  it('samples through the rover, lab and comms, with proximity, cargo and flight constraints', async () => {
    vi.useFakeTimers()
    const sim = new MarsSimulation()
    expect(await run(sim, 'rover-01', 'collect_sample', { target: 'rock-1' })).toMatchObject({
      status: 'error',
    })
    expect(await run(sim, 'hopper-01', 'fly_to', { ...PLACES.field, alt: 10 })).toMatchObject({
      status: 'error',
    })
    expect(await run(sim, 'lab-01', 'unload_rover')).toMatchObject({ status: 'error' })
    expect(await run(sim, 'comms-01', 'send', { report: 'unverified' })).toMatchObject({ status: 'error' })
    await run(sim, 'rover-01', 'drive_to', PLACES.sample)
    await run(sim, 'rover-01', 'collect_sample', { target: 'rock-1' })
    await run(sim, 'rover-01', 'dock')
    await run(sim, 'lab-01', 'unload_rover')
    await run(sim, 'lab-01', 'analyze', { sample: 'rock-1' })
    await run(sim, 'comms-01', 'point', { target: 'earth' })
    expect(await run(sim, 'comms-01', 'send', { report: '' })).toMatchObject({ status: 'error' })
    const report = String(sim.state('lab-01').last_result)
    expect(await run(sim, 'comms-01', 'send', { report })).toMatchObject({ status: 'done' })
    expect(sim.state('comms-01').last_report).toContain('synthetic')
    expect(sim.state('rover-01')).toMatchObject({ cargo: 'none', docked: true })
    await sim.stop()
  })
  it('stops pending motion, refuses resource overlap, and resets without replacing devices', async () => {
    vi.useFakeTimers()
    const sim = new MarsSimulation(),
      rover = sim.device('rover-01')
    const call = rover.call('moving', 'drive_to', PLACES.sample)
    await vi.advanceTimersByTimeAsync(1)
    sim.tick(0.2)
    await vi.advanceTimersByTimeAsync(1)
    expect(rover.call('overlap', 'dock', {}).reason).toBe('busy')
    const at = { ...sim.pose('rover-01') }
    await sim.stop()
    expect(await call.result).toMatchObject({ status: 'interrupted' })
    sim.tick(0.2)
    expect(sim.pose('rover-01')).toEqual(at)
    await sim.reset()
    expect(sim.device('rover-01')).toBe(rover)
    expect(sim.pose('rover-01')).toMatchObject(PLACES.dock)
    expect(sim.state('rover-01').docked).toBe(true)
  })
  it('does not resume motion after a suspended clock, and preserves landing reserve', async () => {
    vi.useFakeTimers()
    const sim = new MarsSimulation(),
      mono = sim.device('monolith-01')
    await mono.manual({ vx: 2, wz: 0 })
    sim.tick(0.1)
    const at = { ...sim.pose('monolith-01') }
    sim.tick(30)
    await vi.advanceTimersByTimeAsync(1)
    sim.tick(0.1)
    expect(sim.pose('monolith-01')).toEqual(at)
    await sim.reset()
    sim.device('hopper-01').update({ propellant: 30 })
    await run(sim, 'hopper-01', 'take_off', { alt: 10 })
    for (let i = 0; i < 250; i++) sim.tick(0.2)
    // The automatic landing stop must settle before attempting another SDK call.
    await vi.advanceTimersByTimeAsync(1)
    expect(sim.pose('hopper-01').z).toBe(0)
    expect(Number(sim.state('hopper-01').propellant)).toBeGreaterThanOrEqual(9.9)
    expect(await run(sim, 'hopper-01', 'take_off', { alt: 10 })).toMatchObject({ status: 'error' })
    await sim.stop()
  })
  it('plans ground routes outside every obstacle and refuses unreachable targets', () => {
    const path = route(PLACES.dock, PLACES.sample)
    let from: { x: number; y: number } = PLACES.dock
    for (const to of path) {
      for (let k = 0; k <= 100; k++)
        for (const obstacle of OBSTACLES) {
          const x = from.x + ((to.x - from.x) * k) / 100,
            y = from.y + ((to.y - from.y) * k) / 100
          expect(Math.hypot(x - obstacle.x, y - obstacle.y)).toBeGreaterThanOrEqual(obstacle.radius + 0.99)
        }
      from = to
    }
    expect(path.at(-1)).toEqual(PLACES.sample)
    expect(() => route(PLACES.dock, PLACES.habitat)).toThrow('no-safe-route')
    expect(() => route(PLACES.dock, { x: NaN, y: 0 })).toThrow('outside-map')
  })
})

describe('profile-owned Mars runtime', () => {
  function transport() {
    const connections: { connection: MarsConnection; disconnect(): void }[] = []
    return {
      connections,
      async connect(): Promise<MarsConnection> {
        let disconnect!: () => void
        const closed = new Promise<void>((resolve) => {
          disconnect = resolve
        })
        const connection = {
          ready: Promise.resolve(),
          closed,
          async close() {
            disconnect()
          },
        }
        connections.push({ connection, disconnect })
        return connection
      },
    }
  }
  it('registers once per profile and keeps devices alive without any attached scene', async () => {
    vi.useFakeTimers()
    const port = transport(),
      runtime = new MarsRuntime(port)
    const first = runtime.start(),
      second = runtime.start()
    expect(first).toBe(second)
    await first
    expect(runtime.snapshot()).toMatchObject({ status: 'ready', online: [...DEVICE_IDS] })
    await vi.advanceTimersByTimeAsync(100)
    await runtime.start()
    expect(port.connections).toHaveLength(11)
    await runtime.reset()
    expect(port.connections).toHaveLength(11)
    port.connections[0]!.disconnect()
    await vi.advanceTimersByTimeAsync(1)
    expect(runtime.snapshot()).toMatchObject({ status: 'unavailable', online: [] })
    await runtime.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('refuses a failed parent connection and never reports a partial fleet ready', async () => {
    const runtime = new MarsRuntime({
      connect: async () => {
        throw new Error('CAPABILITY_DENIED')
      },
    })
    await expect(runtime.start()).rejects.toThrow('CAPABILITY_DENIED')
    expect(runtime.snapshot()).toMatchObject({ status: 'unavailable', online: [] })
    await runtime.stop()
  })
  it.each(['stop', 'timeout'] as const)(
    'aborts incomplete registration on %s and closes a late connection',
    async (reason) => {
      vi.useFakeTimers()
      let connected!: (connection: MarsConnection) => void
      const runtime = new MarsRuntime({
        connect: () =>
          new Promise((resolve) => {
            connected = resolve
          }),
      })
      const starting = runtime.start()
      const outcome = starting.catch((error) => error)
      await vi.advanceTimersByTimeAsync(1)
      if (reason === 'stop') await runtime.stop()
      else await vi.advanceTimersByTimeAsync(10_000)
      let closed = false
      connected({
        ready: Promise.resolve(),
        closed: new Promise(() => {}),
        async close() {
          closed = true
        },
      })
      await outcome
      expect(closed).toBe(true)
      expect(runtime.snapshot()).toMatchObject({
        status: reason === 'stop' ? 'stopped' : 'unavailable',
        online: [],
      })
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
