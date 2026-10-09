import { type Call, CallError } from '@agnes/mhs/device'
import * as THREE from 'three'
import { LAYOUT } from '../base.js'
import { OBSTACLES } from '../terrain.js'
import { addCamera } from './camera.js'
import { castRay } from './map.js'
import { addPlace, reading } from './place.js'
import { fromMap, inTheWay, type Point, planRoute, ROVER, round, toMap } from './route.js'
import { Blocked, Body, every, type World, WorldDevice, wait } from './world.js'

/** The lidar on the mast: one sweep, all round, every 2 degrees. */
const LIDAR = { range: 30, step: 2, height: 1.9, ahead: 0.8 }
const REACH = 4
/** Driving: top speed in m/s, acceleration in m/s², turning in radians a second. */
const DRIVE = { speed: 2, accel: 1.2, turn: Math.PI / 2 }
/** Seconds the drill takes for one sample. */
const DRILL_S = 4

/** The rover: drives routes, stops by itself before boulders and people (from the scene's truth), collects samples, docks. */
export function rover(world: World, log: (line: string) => void): WorldDevice {
  const { rover: model } = world.parts
  const body = new Body(model, world)
  let battery = 81
  const dev = new WorldDevice({
    id: 'rover-01',
    kind: 'rover',
    name: 'Rover',
    model: 'Agnes Base rover',
    mobile: true,
    radius: 1.6,
    localization: 'self',
    profile: {
      size_m: [3.0, 2.7, 2.2],
      weight_kg: 1025,
      max_speed: DRIVE.speed,
      reach_m: REACH,
      notes:
        'Six-wheeled rover with a sampling arm and a drill. Stops by itself before boulders and people. Charges in the dock beside the lab.',
    },
    resources: { chassis: 'reject', arm: 'reject' },
    manual: {
      axes: [
        { id: 'vx', role: 'forward', unit: 'm/s', min: -1, max: DRIVE.speed, keys: ['w', 's'] },
        { id: 'wz', role: 'turn', unit: 'deg/s', min: -60, max: 60, keys: ['a', 'd'] },
      ],
      rate_hz: 10,
      deadman_s: 0.5,
    },
    ui: { primary: 'front_video' },
    state: {
      mode: { type: 'string', enum: ['idle', 'driving', 'sampling', 'docked'] },
      battery: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        role: 'battery',
        alert: { warn: 25, bad: 10, below: true },
      },
      cargo: { type: 'integer', min: 0, max: 4, description: 'samples on board' },
      docked: { type: 'boolean', description: 'in the dock, charging, where the lab can reach it' },
    },
  })
  dev.log = log
  const report = () => dev.update({ battery, cargo: world.rover.cargo.length, docked: world.rover.docked })
  dev.update({ mode: 'docked', battery, cargo: 0, docked: true })
  world.roverChanged = report

  const front = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 2000)
  front.rotation.order = 'YXZ'
  front.rotation.set(-0.35, Math.PI, 0)
  front.position.set(0, 1.9, 1.2)
  model.add(front)
  addCamera(
    dev,
    world,
    front,
    {
      id: 'front',
      description: 'navigation camera on the mast, looking ahead and 20 degrees down',
      mount: { xyz: [1.2, 0, 1.9], rpy: [0, 20, 0] },
      default: true,
    },
    log,
  )
  const low = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 500)
  low.rotation.order = 'YXZ'
  low.rotation.set(-0.8, Math.PI, 0)
  low.position.set(0, 0.75, 1.45)
  model.add(low)
  addCamera(
    dev,
    world,
    low,
    {
      id: 'hazcam',
      description: 'hazard camera low on the front, looking down at the ground just ahead',
      mount: { xyz: [1.45, 0, 0.75], rpy: [0, 45, 0] },
      video: false,
    },
    log,
  )
  addPlace(dev, world, body, { what: 'rover', maxError: 0.3, hz: 5 }, log)
  const odometry = dev.source('odometry', 'odometry', 'wheel odometry since start-up', { hz: 5 })
  const lidar = dev.source('lidar', 'scan', 'lidar on the mast, sweeping all round', {
    hz: 5,
    range_m: [0.3, LIDAR.range],
    mount: { xyz: [LIDAR.ahead, 0, LIDAR.height], rpy: [0, 0, 0] },
  })
  const health = dev.source('health', 'values', 'drive motors, battery and electronics', {
    hz: 1,
    fields: {
      voltage: { type: 'number', unit: 'V', min: 22, max: 30, role: 'voltage', of: 'main' },
      current: { type: 'number', unit: 'A', min: 0, max: 40, role: 'current', of: 'motor' },
      motor_temperature: {
        type: 'number',
        unit: '°C',
        min: -60,
        max: 100,
        role: 'temperature',
        of: 'motor',
        alert: { warn: 70, bad: 85 },
      },
      battery_temperature: {
        type: 'number',
        unit: '°C',
        min: -40,
        max: 50,
        role: 'temperature',
        of: 'battery',
        alert: { warn: -10, bad: -20, below: true },
      },
      electronics_temperature: {
        type: 'number',
        unit: '°C',
        min: -40,
        max: 80,
        role: 'temperature',
        of: 'electronics',
        alert: { warn: 55, bad: 70 },
      },
      cpu: { type: 'number', unit: '%', min: 0, max: 100, role: 'cpu', alert: { warn: 85, bad: 95 } },
    },
  })

  every(
    200,
    () => {
      if (odometry.wants()) odometry.send(body.odometry())
      if (lidar.wants()) {
        const footprints = world.footprints()
        const people = world
          .obstacles(['rover-01'])
          .filter((t) => t.label === 'astronaut')
          .map((t) => ({ x: t.x, z: t.z, r: t.r }))
        const at = {
          x: body.at.x + Math.sin(body.heading) * LIDAR.ahead,
          z: body.at.z + Math.cos(body.heading) * LIDAR.ahead,
        }
        const ranges: (number | null)[] = []
        // Counter-clockwise from straight behind, in the sensor frame (MOS Appendix B).
        for (let a = -180; a < 180; a += LIDAR.step) {
          const d = castRay(
            at.x,
            at.z,
            body.heading + (a * Math.PI) / 180,
            [...footprints, ...people],
            LIDAR.range,
          )
          ranges.push(d === undefined ? null : round(d))
        }
        lidar.send({ angle_min: -180, angle_inc: LIDAR.step, ranges })
      }
    },
    log,
  )
  // Motors warm while driving and cool at rest; the battery is heated to stay above freezing.
  let motor = -12
  every(
    1000,
    () => {
      const driving = body.speed > 0.05 || Math.abs(body.turn) > 0.05
      motor += driving ? (60 - motor) * 0.02 : (-12 - motor) * 0.01
      if (!health.wants()) return
      health.send({
        voltage: reading(24 + battery * 0.05, 0.05, 2),
        current: reading(driving ? 14 + body.speed * 8 : world.rover.docked ? 0.8 : 2.2, 0.4),
        motor_temperature: reading(motor, 0.3),
        battery_temperature: reading(world.rover.docked ? 12 : 6, 0.3),
        electronics_temperature: reading(driving ? 31 : 24, 0.5),
        cpu: reading(driving ? 62 : 18, 3, 0),
      })
    },
    log,
  )
  every(
    5000,
    () => {
      battery = Math.max(0, Math.min(100, battery + (world.rover.docked ? 2 : body.speed > 0 ? -1 : 0)))
      report()
    },
    log,
  )

  dev.after = () => ({ pose: body.pose(), odometry: body.odometry() })
  // Manual driving: the latest axes, applied frame by frame; the deadman zeroes them (MAN-4).
  const manual = { vx: 0, wz: 0 }
  dev.onManual = (axes) => {
    manual.vx = axes.vx ?? 0
    manual.wz = axes.wz ?? 0
    if (manual.vx !== 0 || manual.wz !== 0) {
      if (world.rover.docked) {
        world.rover.docked = false
        report()
      }
      dev.update({ mode: 'driving' })
    } else dev.update({ mode: world.rover.docked ? 'docked' : 'idle' })
  }
  dev.onStop = () => {
    body.speed = 0
    manual.vx = 0
    manual.wz = 0
  }
  let manualAt = performance.now()
  let steering = false
  every(
    33,
    () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - manualAt) / 1000)
      manualAt = now
      if (manual.vx === 0 && manual.wz === 0) {
        if (steering) body.speed = body.turn = 0
        steering = false
        return
      }
      steering = true
      // The safety stop holds under manual control too: no driving forward into a boulder or a person.
      const vx = manual.vx > 0 && ahead() ? 0 : manual.vx
      body.object.rotation.y += ((manual.wz * Math.PI) / 180) * dt
      body.object.position.x += Math.sin(body.heading) * vx * dt
      body.object.position.z += Math.cos(body.heading) * vx * dt
      body.object.position.y = world.ground(body.at)
      body.odometer += Math.abs(vx * dt)
      body.speed = vx
      body.turn = (manual.wz * Math.PI) / 180
    },
    log,
  )

  /**
   * Something just ahead of the nose, inside the rover's width, short of where it is driving to
   * (`remaining` metres on): a boulder or a person.
   */
  const ahead = (remaining?: number): string | undefined => {
    const nose = {
      x: body.at.x + Math.sin(body.heading) * ROVER.nose,
      z: body.at.z + Math.cos(body.heading) * ROVER.nose,
    }
    const hit = inTheWay(body.at, body.heading, world.inTheWay().stops, remaining)
    if (!hit) return undefined
    const gap = Math.max(0, Math.hypot(hit.x - nose.x, hit.z - nose.z) - hit.r)
    const what = (hit as { label?: string }).label ?? 'something'
    const at = toMap(hit)
    return `stopped ${round(gap, 1)} m before ${what === 'astronaut' ? 'an astronaut' : `a ${what}`} at (${at.x}, ${at.y})`
  }

  const drive = async (call: Call, points: Point[]) => {
    world.rover.docked = false
    report()
    dev.update({ mode: 'driving' })
    try {
      for (const [i, p] of points.entries()) {
        await body.go(call, p, {
          speed: DRIVE.speed,
          accel: DRIVE.accel,
          turnRate: DRIVE.turn,
          arrive: 0.25,
          blocked: ahead,
        })
        call.progress({ done: i + 1, total: points.length, text: `leg ${i + 1} of ${points.length} done` })
      }
    } catch (e) {
      if (e instanceof Blocked) throw new CallError('estop', e.message)
      throw e
    } finally {
      dev.update({ mode: world.rover.docked ? 'docked' : 'idle' })
    }
  }
  const where = () => {
    const p = toMap(body.at)
    return `at (${p.x}, ${p.y})`
  }

  dev.tool(
    {
      name: 'drive_to',
      description:
        'Drive straight to a point on the base map (x east, y north, metres). Stops by itself before a boulder or a person in the way.',
      timeout: 260,
      params: {
        x: { type: 'number', minimum: -150, maximum: 150 },
        y: { type: 'number', minimum: -150, maximum: 150 },
      },
      required: ['x', 'y'],
      uses: ['chassis'],
      motion: true,
      pausable: true,
    },
    async (call, { x, y }) => {
      await drive(call, [fromMap(x, y)])
      return `arrived ${where()}`
    },
  )
  dev.tool(
    {
      name: 'follow_route',
      description:
        'Drive through points on the base map in order (x east, y north, metres), such as data.route from a hopper survey. Stops by itself before a boulder or a person in the way.',
      timeout: 400,
      params: {
        points: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              x: { type: 'number', minimum: -150, maximum: 150 },
              y: { type: 'number', minimum: -150, maximum: 150 },
            },
            required: ['x', 'y'],
          },
        },
      },
      required: ['points'],
      uses: ['chassis'],
      motion: true,
      pausable: true,
    },
    async (call, { points }) => {
      const legs = (points as { x: number; y: number }[]).map((p) => fromMap(p.x, p.y))
      await drive(call, legs)
      return `followed ${legs.length} legs, arrived ${where()}`
    },
  )
  dev.tool(
    {
      name: 'collect_sample',
      description: `Take a sample of a rock with the arm, by its id from a survey (such as rock-1). The rock must be within ${REACH} m.`,
      timeout: DRILL_S + 20,
      params: { target: { type: 'string', maxLength: 40 } },
      required: ['target'],
      uses: ['arm'],
      motion: true,
    },
    async (call, { target }) => {
      const rock = OBSTACLES.find((o) => o.id === target)
      if (rock?.label !== 'unusual rock')
        throw new CallError('x_no_such_rock', `there is no sample rock ${target}`)
      const d = Math.hypot(rock.x - body.at.x, rock.z - body.at.z) - rock.r
      if (d > REACH)
        throw new CallError(
          'unreachable',
          `${target} is ${round(d, 1)} m away; drive within ${REACH} m first`,
        )
      if (world.rover.cargo.includes(target as string))
        throw new CallError('x_already_sampled', `${target} was already sampled`)
      dev.update({ mode: 'sampling' })
      try {
        for (let i = 1; i <= DRILL_S * 2; i++) {
          await wait(call, 500)
          call.progress({ done: i, total: DRILL_S * 2, text: `drilling ${target}` })
        }
      } finally {
        dev.update({ mode: 'idle' })
      }
      world.rover.cargo.push(target as string)
      rock.object.scale.multiplyScalar(0.8)
      report()
      return {
        detail: `collected a sample of ${target}; ${world.rover.cargo.length} on board`,
        data: { sample: target },
      }
    },
  )
  dev.tool(
    {
      name: 'dock',
      description:
        'Drive back into the dock beside the lab, around the boulders the base knows about, to charge and let the lab unload samples.',
      timeout: 300,
      uses: ['chassis'],
      motion: true,
      pausable: true,
    },
    async (call) => {
      const [x, z] = LAYOUT.dock
      // The way home is known ground: plan around the base map's boulders and people, then back in.
      const home = planRoute(body.at, { x, z: z + 7 }, world.obstacles(['rover-01']), ROVER.halfWidth + 0.8)
      await drive(call, [...home, { x, z: z + 0.4 }])
      world.rover.docked = true
      dev.update({ mode: 'docked' })
      report()
      return 'docked; charging'
    },
  )
  world.onReset(() => {
    battery = 81
    manual.vx = 0
    manual.wz = 0
    body.reset()
    dev.update({ mode: 'docked' })
    report()
  })
  return dev
}
