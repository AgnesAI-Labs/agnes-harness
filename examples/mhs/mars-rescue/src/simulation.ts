import { type CallContext, Device, type Json } from '@agnes/mhs-device'
import { INITIAL, registration } from './devices.js'
import { DEVICE_IDS, type DeviceId, PLACES, type Point, type Pose, route, SPAWNS } from './world.js'

export class MarsSimulation {
  readonly devices = new Map<DeviceId, Device>()
  readonly poses = new Map<DeviceId, Pose>()
  private readonly velocities = new Map<DeviceId, { vx: number; wz: number }>()
  private readonly deadlines = new Map<DeviceId, number>()
  private readonly sleepers = new Set<{ id: DeviceId; wake(): void; reject(): void }>()
  private clock = 0
  private stopped = false
  constructor(video = false) {
    for (const id of DEVICE_IDS) {
      this.poses.set(id, { ...SPAWNS[id], z: 0, yaw: 0 })
      const device = new Device(registration(id, video), {
        arm: (milliseconds) => this.deadlines.set(id, this.clock + milliseconds / 1000),
        stop: async () => {
          this.velocities.delete(id)
          this.deadlines.delete(id)
        },
      })
      this.devices.set(id, device)
      device.update(structuredClone(INITIAL[id]))
      device.onManual = async (axes) => {
        if (this.stopped) throw new Error('simulation-stopped')
        this.velocities.set(id, { vx: axes.vx ?? 0, wz: axes.wz ?? 0 })
      }
      for (const t of device.description.tools ?? [])
        device.tool(t.name, (args, call) => this.action(id, t.name, args, call))
    }
  }
  device(id: DeviceId): Device {
    return this.devices.get(id)!
  }
  state(id: DeviceId): Record<string, Json> {
    return this.device(id).state()
  }
  pose(id: DeviceId): Pose {
    return this.poses.get(id)!
  }
  snapshot() {
    return DEVICE_IDS.map((id) => ({ id, pose: { ...this.pose(id) }, state: this.state(id) }))
  }
  /** A suspended page advances no physics. On resumption it stops, never catches up motion. */
  tick(seconds: number): void {
    if (this.stopped) return
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 0.25) {
      void this.stop()
      return
    }
    this.clock += seconds
    for (const [id, until] of this.deadlines) if (until < this.clock) void this.device(id).stop('deadman')
    for (const [id, axes] of this.velocities) {
      const p = this.pose(id),
        next = { x: p.x + Math.cos(p.yaw) * axes.vx * seconds, y: p.y + Math.sin(p.yaw) * axes.vx * seconds }
      try {
        // Reject direct unsafe movement; manual steering never teleports around an obstacle.
        const legs = route(p, next)
        if (legs.length !== 1) throw new Error('obstacle')
        Object.assign(p, next, { yaw: p.yaw + axes.wz * seconds })
      } catch {
        void this.device(id).stop('obstacle')
      }
    }
    const hopper = this.state('hopper-01'),
      hp = this.pose('hopper-01')
    if (hp.z > 0) {
      const propellant = Math.max(0, Number(hopper.propellant) - seconds * 0.5)
      this.device('hopper-01').update({
        propellant,
        flight_time_left: Math.max(0, (propellant - 10) * 2),
        max_altitude: Math.min(30, Math.max(0, propellant - 10)),
      })
      if (propellant <= 10) {
        hp.z = 0
        this.device('hopper-01').update({ mode: 'landed' })
        void this.device('hopper-01').stop('landing-reserve')
      }
    }
    if (this.state('monolith-01').carrying === 'astronaut')
      Object.assign(this.pose('suit-01'), this.pose('monolith-01'))
    for (const id of DEVICE_IDS) {
      const { x, y, yaw } = this.pose(id)
      this.device(id).publish('pose', { map: 'mars-base', x, y, yaw: (yaw * 180) / Math.PI, ok: true })
      this.device(id).publish('readings', this.readings(id))
    }
    for (const sleeper of [...this.sleepers]) sleeper.wake()
  }
  private readings(id: DeviceId): Record<string, Json> {
    const { problem: _problem, faults: _faults, ...values } = this.state(id)
    return values
  }
  private async step(id: DeviceId, call: CallContext): Promise<void> {
    await call.checkpoint()
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.sleepers.delete(entry)
        call.signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        cleanup()
        reject(new Error('interrupted'))
      }
      const entry = {
        id,
        wake: () => {
          cleanup()
          resolve()
        },
        reject: abort,
      }
      this.sleepers.add(entry)
      call.signal.addEventListener('abort', abort, { once: true })
      if (call.signal.aborted || this.stopped) abort()
    })
    call.signal.throwIfAborted()
  }
  private async move(id: DeviceId, target: Point, call: CallContext, airborne = false): Promise<void> {
    const p = this.pose(id),
      legs = airborne ? [target] : route(p, target)
    this.device(id).update({ mode: 'moving', ...(id === 'rover-01' ? { docked: false } : {}) })
    const start = this.clock
    try {
      for (const end of legs)
        while (Math.hypot(p.x - end.x, p.y - end.y) > 0.1) {
          const before = this.clock
          await this.step(id, call)
          const dx = end.x - p.x,
            dy = end.y - p.y,
            d = Math.hypot(dx, dy)
          const distance = Math.min(d, (this.clock - before) * (airborne ? 10 : 4))
          if (airborne && p.z <= 0) throw new Error('not-airborne')
          p.x += (dx / d) * distance
          p.y += (dy / d) * distance
          p.yaw = Math.atan2(dy, dx)
          call.progress({ remaining_m: Math.hypot(p.x - end.x, p.y - end.y) })
          if (this.clock - start > 110) throw new Error('route-timeout')
        }
    } finally {
      this.device(id).update({ mode: airborne && p.z > 0 ? 'hovering' : 'idle' })
    }
  }
  private near(a: DeviceId, b: Point, limit = 4): void {
    if (Math.hypot(this.pose(a).x - b.x, this.pose(a).y - b.y) > limit) throw new Error('too-far')
  }
  private async action(
    id: DeviceId,
    name: string,
    args: Record<string, Json>,
    call: CallContext,
  ): Promise<Json> {
    if (this.stopped) throw new Error('simulation-stopped')
    await call.checkpoint()
    const d = this.device(id),
      state = this.state(id),
      p = this.pose(id)
    switch (name) {
      case 'drive_to':
      case 'go_to':
        await this.move(id, { x: Number(args.x), y: Number(args.y) }, call)
        break
      case 'follow_route':
        for (const point of args.points as number[][])
          await this.move(id, { x: point[0]!, y: point[1]! }, call)
        break
      case 'dock':
        await this.move(id, PLACES.dock, call)
        d.update({ docked: true })
        break
      case 'collect_sample':
        this.near(id, PLACES.sample)
        if (state.cargo !== 'none') throw new Error('cargo-full')
        d.update({ cargo: 'rock-1' })
        break
      case 'take_off':
        if (p.z > 0 || Number(state.propellant) < 30) throw new Error('unsafe-takeoff')
        p.z = Math.min(Number(args.alt), Number(state.max_altitude))
        d.update({ mode: 'hovering' })
        break
      case 'fly_to':
        if (p.z <= 0 || Number(args.alt) > Number(state.max_altitude)) throw new Error('unsafe-flight')
        p.z = Number(args.alt)
        await this.move(id, { x: Number(args.x), y: Number(args.y) }, call, true)
        break
      case 'survey':
        if (p.z <= 0) throw new Error('not-airborne')
        return {
          sample: { ...PLACES.sample },
          astronaut: { ...this.pose('suit-01') },
          route: route(PLACES.dock, PLACES.sample).map((v) => [v.x, v.y]),
        }
      case 'land':
        await this.move(id, PLACES.pad, call, true)
        p.z = 0
        d.update({ mode: 'landed' })
        break
      case 'follow': {
        const target = String(args.target) as DeviceId,
          until = this.clock + Number(args.seconds)
        while (this.clock < until) {
          const t = this.pose(target)
          if (Math.hypot(p.x - t.x, p.y - t.y) > 3) await this.move(id, { x: t.x + 2, y: t.y }, call)
          await this.step(id, call)
        }
        break
      }
      case 'carry':
        if (state.carrying !== 'none') throw new Error('already-carrying')
        this.near(id, args.target === 'suit-01' ? this.pose('suit-01') : PLACES.sample)
        d.update({ carrying: args.target === 'suit-01' ? 'astronaut' : 'sample' })
        break
      case 'put_down':
        d.update({ carrying: 'none' })
        break
      case 'say':
        return { spoken: args.text! }
      case 'set_mode':
        d.update({ mode: args.mode! })
        break
      case 'open_outer':
        if (Number(state.pressure) > 1 || state.inner !== 'closed') throw new Error('pressure-interlock')
        d.update({ outer: 'open' })
        break
      case 'close_outer':
        d.update({ outer: 'closed' })
        break
      case 'cycle_out':
        d.update({ inner: 'closed', outer: 'closed', pressure: 0, mode: 'depressurized' })
        break
      case 'cycle_in':
        d.update({ inner: 'closed', outer: 'closed', pressure: 101, mode: 'pressurized' })
        if (
          Math.hypot(this.pose('suit-01').x - PLACES.airlock.x, this.pose('suit-01').y - PLACES.airlock.y) < 5
        ) {
          this.device('suit-01').update({ rescued: true, o2_left: 100 })
          d.update({ occupied: true })
        }
        break
      case 'unload_rover':
        if (!this.state('rover-01').docked || this.state('rover-01').cargo !== 'rock-1')
          throw new Error('no-docked-sample')
        this.device('rover-01').update({ cargo: 'none' })
        d.update({ queue: 'rock-1' })
        break
      case 'analyze':
        if (state.queue !== args.sample) throw new Error('no-sample')
        d.update({ queue: 'none', last_result: 'rock-1: hydrated silicate (synthetic)', mode: 'idle' })
        break
      case 'point':
        d.update({ target: args.target!, link: true })
        break
      case 'send':
        if (!state.link || !state.window) throw new Error('no-link-window')
        d.update({ last_report: args.report! })
        break
      case 'stow_array':
        d.update({ panels: 'stowed', production: 0 })
        break
      case 'deploy_array':
        d.update({ panels: 'deployed', production: 8 })
        break
      case 'clean_array':
        d.update({ dust: 0 })
        break
      case 'shed':
        d.update({ shed: args.on ? args.load! : 'none' })
        break
      case 'look_at':
        d.update({ preset: args.preset! })
        break
      case 'zoom':
        d.update({ zoom: args.level! })
        break
      default:
        throw new Error('unsupported-tool')
    }
    return { simulated: true, device: id, state: this.state(id) }
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.velocities.clear()
    this.deadlines.clear()
    await Promise.all([...this.devices.values()].map((device) => device.stop('example-stop')))
    for (const sleeper of [...this.sleepers]) sleeper.reject()
  }
  async reset(): Promise<void> {
    await this.stop()
    for (const id of DEVICE_IDS) {
      Object.assign(this.pose(id), SPAWNS[id], { z: 0, yaw: 0 })
      this.device(id).update(structuredClone(INITIAL[id]))
    }
    this.stopped = false
  }
}
