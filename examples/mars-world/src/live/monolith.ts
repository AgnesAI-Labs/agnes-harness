import { type Call, CallError } from '@agnes/mhs/device'
import * as THREE from 'three'
import { LAYOUT } from '../base.js'
import { MONOLITH } from '../devices.js'
import { UNFOLD_S } from '../monolith.js'
import { OBSTACLES } from '../terrain.js'
import { addCamera } from './camera.js'
import { MAP_AREA } from './map.js'
import { addPlace, reading } from './place.js'
import {
  type Circle,
  fromMap,
  headingTo,
  MONO,
  monolithAhead,
  openAround,
  type Point,
  planNear,
  round,
  toMap,
} from './route.js'
import { Blocked, Body, every, type Thing, turnTo, type World, WorldDevice, wait } from './world.js'

/** Gaits: top speed in m/s, acceleration in m/s², turning in radians a second. */
const GAIT = {
  walk: { speed: 1.3, accel: 1.2, turn: Math.PI * 0.7 },
  roll: { speed: 6, accel: 2, turn: Math.PI / 2 },
}
/** From its front to what it picks up, at most, in metres. */
const REACH = 1.2
/** Seconds to lift or set down a load. */
const LIFT_S = 1.5
/** Where it holds an astronaut: this far in front of its centre and this high off the ground. */
const HELD = { ahead: 0.72, up: 0.32 }
/** It counts as at the airlock within this many metres of the outer door, and at the lab of the lab. */
const AT_AIRLOCK = 3
const AT_LAB = 6
/** In the airlock's chamber, just inside the outer door, in world coordinates. */
const CHAMBER = { x: 0, z: 10.6 }
/** Devices and people it can follow. */
const FOLLOWABLE = ['suit-01', 'rover-01', 'hopper-01']
/** Follow ends this close to a machine's edge; to a person it walks up to its stop distance. */
const MACHINE_GAP = 1.5
/** Following plans its way again once the target has moved this far from where it was, in metres. */
const REPLAN_M = 1
const ARRIVED = 'arrived'
const REPLAN = 'replan'

/**
 * What it adds to what it says, by its settings: the higher `humor`, the more it jokes; the lower
 * `honesty`, the more it smooths things over. Facts in tool results stay plain whatever they are.
 */
const QUIPS = [
  'Four slabs, no complaints.',
  'Walking is slower, but it is good for my image.',
  'I would roll there, but someone has to keep the dust company.',
  'That was the plan. I will act as if it was mine.',
  'Mars has no air, and still I have timing.',
]
const DRY = ['Copy.', 'Understood.', 'On it.']
const LINES = {
  pickup: {
    honest: 'I have you. Hold still; the walk to the airlock is bumpy.',
    smooth: 'I have you. This will be a perfectly smooth ride.',
  },
  chamber: {
    honest: 'You are in the airlock. Not my most graceful delivery.',
    smooth: 'Delivered, flawlessly.',
  },
  standing: { honest: 'Setting you down here. Stay where you are.', smooth: 'Here we are. Lovely spot.' },
}

/**
 * Monolith: four metal slabs joined at the middle, a robot built to work beside people. It walks by
 * swinging its slabs, unfolds into a wheel to roll fast over open ground, follows people and
 * machines, carries an astronaut or a rock sample, and talks over the radio. It finds its way on the
 * base map around buildings, boulders and machines, stops by itself before a boulder or machine in
 * its way, and comes as close as half a metre to a person.
 */
export function monolith(world: World, log: (line: string) => void): WorldDevice {
  const { monolith: model, astronaut } = world.parts
  const body = new Body(model.group, world)
  let battery = 93
  let humor = 75
  let honesty = 90
  let motor = -20
  let load: { kind: 'astronaut' | 'sample'; id: string } | undefined
  let moving: 'walk' | 'roll' | undefined
  /** The motion call running now, which the stop tool ends. */
  let current: Call | undefined
  const samples = OBSTACLES.filter((o) => o.label === 'unusual rock').map((o) => o.id)
  const dev = new WorldDevice({
    id: MONOLITH.id,
    kind: 'robot',
    name: MONOLITH.name,
    model: 'Agnes Base four-slab robot',
    mobile: true,
    radius: 0.4,
    localization: 'self',
    profile: {
      size_m: [0.42, 0.6, 1.5],
      weight_kg: 280,
      max_speed: GAIT.roll.speed,
      payload_kg: 180,
      reach_m: REACH,
      notes: `Four metal slabs joined at the middle, about 1.5 m tall. It walks at ${GAIT.walk.speed} m/s by swinging its slabs; on open ground it unfolds into a wheel and rolls at ${GAIT.roll.speed} m/s (not while it carries something). It finds its own way on the base map around buildings, boulders and machines. Built to work beside people: it comes within ${MONO.personGap} m of a person, but stops by itself before a boulder or a machine in its way. It can carry an astronaut or a rock sample. humor and honesty (0-100 %) change how it phrases what it says, never the facts in its results.`,
    },
    resources: { slabs: 'reject', radio: 'queue' },
    manual: {
      axes: [
        { id: 'vx', role: 'forward', unit: 'm/s', min: -0.5, max: GAIT.walk.speed, keys: ['w', 's'] },
        { id: 'wz', role: 'turn', unit: 'deg/s', min: -90, max: 90, keys: ['a', 'd'] },
      ],
      rate_hz: 10,
      deadman_s: 0.5,
    },
    ui: { primary: 'front_video' },
    state: {
      mode: {
        type: 'string',
        enum: ['idle', 'walking', 'rolling', 'carrying'],
        description:
          'standing idle, walking, rolling as a wheel, or carrying a load (lifting, holding, walking with it)',
      },
      carrying: { type: 'string', enum: ['none', 'astronaut', 'sample'], description: 'what it holds' },
      battery: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        role: 'battery',
        alert: { warn: 25, bad: 10, below: true },
      },
      humor: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        writable: true,
        description: 'how much it jokes in what it says',
      },
      honesty: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        writable: true,
        description: 'how plainly it tells people how things are, rather than smoothing them over',
      },
    },
  })
  dev.log = log
  const mode = () => (moving === 'roll' ? 'rolling' : load ? 'carrying' : moving ? 'walking' : 'idle')
  const report = () =>
    dev.update({ mode: mode(), carrying: load?.kind ?? 'none', battery: Math.round(battery), humor, honesty })
  report()
  dev.onSet = (name, value) => {
    if (name === 'humor') humor = value as number
    if (name === 'honesty') honesty = value as number
    return value
  }

  // The front camera in the display strip, held level as the slabs swing.
  const front = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 2000)
  front.rotation.order = 'YXZ'
  front.rotation.set(-0.12, Math.PI, 0)
  front.position.set(0, 1.36, 0.24)
  model.group.add(front)
  addCamera(
    dev,
    world,
    front,
    {
      id: 'front',
      description: 'front camera beside the display strip, 1.36 m up, looking ahead and 7 degrees down',
      mount: { xyz: [0.24, 0, 1.36], rpy: [0, 7, 0] },
      default: true,
    },
    log,
  )
  addPlace(dev, world, body, { what: 'robot', maxError: 0.3 }, log)
  const odometry = dev.source('odometry', 'odometry', 'from its hinge encoders, since start-up', { hz: 5 })
  every(200, () => void (odometry.wants() && odometry.send(body.odometry())), log)
  const health = dev.source('health', 'values', 'battery and the hinge motors', {
    hz: 1,
    fields: {
      battery: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        role: 'battery',
        alert: { warn: 25, bad: 10, below: true },
      },
      motor_temperature: {
        type: 'number',
        unit: '°C',
        min: -60,
        max: 100,
        role: 'temperature',
        of: 'motor',
        alert: { warn: 70, bad: 85 },
        description: 'the hinge motors that swing the slabs',
      },
    },
  })
  every(
    1000,
    () => {
      const working = body.speed > 0.05 || Math.abs(body.turn) > 0.05
      const effort = moving === 'roll' ? 2 : load ? 1.6 : 1
      motor += working ? (25 + 25 * effort - motor) * 0.03 : (-20 - motor) * 0.01
      battery = Math.max(0, battery - (working ? 0.02 * effort : 0.002))
      if (health.wants())
        health.send({ battery: Math.round(battery), motor_temperature: reading(motor, 0.3) })
    },
    log,
  )
  every(5000, report, log)

  // An astronaut in its hold goes where it goes, every frame.
  const hold = () => {
    const h = body.heading
    const p = body.at
    const x = p.x + Math.sin(h) * HELD.ahead
    const z = p.z + Math.cos(h) * HELD.ahead
    astronaut.position.set(x, world.ground({ x, z }) + HELD.up, z)
    astronaut.rotation.set(-0.1, h, 0)
  }
  every(
    33,
    () => {
      if (load?.kind === 'astronaut') hold()
    },
    log,
  )

  // What says something: a bubble over it in the scene, for longer the more it says.
  const speak = (text: string) => {
    model.speech.text = text
    model.speech.until = performance.now() + 2500 + text.length * 60
    return text
  }
  const voice = (line: { honest: string; smooth: string }) => (honesty >= 50 ? line.honest : line.smooth)
  let said = 0
  const flavour = (text: string) => {
    said += 1
    const extra =
      humor >= 70 ? ` ${QUIPS[said % QUIPS.length]}` : humor >= 40 ? ` ${DRY[said % DRY.length]}` : ''
    return `${text}${extra}${honesty < 30 ? ' Trust me.' : ''}`
  }

  const where = (p: Point = body.at) => {
    const m = toMap(p)
    return `(${m.x}, ${m.y})`
  }
  /** What it must keep clear of: everything but itself, what it holds, and `except`. */
  const around = (except: string[] = []): Thing[] =>
    world.obstacles([MONOLITH.id, ...(load?.kind === 'astronaut' ? ['suit-01'] : []), ...except])
  const describe = (hit: Thing) => {
    const nose = MONO.nose + (load?.kind === 'astronaut' ? MONO.held : 0)
    const front = {
      x: body.at.x + Math.sin(body.heading) * nose,
      z: body.at.z + Math.cos(body.heading) * nose,
    }
    const gap = Math.max(0, Math.hypot(hit.x - front.x, hit.z - front.z) - hit.r)
    const what =
      hit.label === 'astronaut'
        ? 'an astronaut'
        : `${hit.label === 'unusual rock' ? 'the' : 'a'} ${hit.label}`
    return `stopped ${round(gap, 1)} m before ${what} at ${where(hit)}`
  }
  const hazard = (gait: 'walk' | 'roll', remaining: number, except: string[] = []) =>
    monolithAhead(body.at, body.heading, around(except), gait, remaining, load?.kind === 'astronaut')

  /** A way on the base map to `to`, or as near it as can be reached, keeping the gait's clearance. */
  const plan = (to: Point, gait: 'walk' | 'roll', except: string[] = []) => {
    const clearance = MONO.clearance[gait]
    const things: Circle[] = around(except).map((t) => ({
      x: t.x,
      z: t.z,
      r: t.r + (t.label === 'astronaut' ? 0.3 : 0),
    }))
    const keepouts = things.map((t) => ({ ...t, r: t.r + clearance }))
    const grid = world.planGrid()
    if (gait === 'roll') {
      for (const [p, what] of [
        [body.at, 'here'],
        [to, where(to)],
      ] as const)
        if (!openAround(grid, things, p, clearance))
          throw new CallError(
            'x_not_open_ground',
            `cannot roll: ${what} is not open ground (within ${clearance} m of buildings, boulders, machines or people); walk instead (gait walk)`,
          )
      const way = planNear(grid, body.at, to, keepouts, clearance, 0)
      if (!way)
        throw new CallError(
          'x_not_open_ground',
          `cannot roll: no way from ${where()} to ${where(to)} keeps ${clearance} m from buildings, boulders, machines and people; walk instead (gait walk)`,
        )
      return way
    }
    const way = planNear(grid, body.at, to, keepouts, clearance)
    if (!way)
      throw new CallError('x_no_way', `no way on the base map from ${where()} to within 4 m of ${where(to)}`)
    return way
  }

  const fold = async (call: Call) => {
    model.want.wheel = false
    while (model.unfolded > 0) await wait(call, 50)
  }
  /** Walks or rolls `path` leg by leg; `blocked` may end it early, as Body.go does. */
  const travel = async (
    call: Call,
    path: Point[],
    gait: 'walk' | 'roll',
    blocked: (remaining: number) => string | undefined,
  ) => {
    const g = GAIT[gait]
    let done = 0
    for (const p of path) {
      await body.go(call, p, { speed: g.speed, accel: g.accel, turnRate: g.turn, arrive: 0.2, blocked })
      done += 1
      call.progress({
        done,
        total: path.length,
        text: `${gait === 'roll' ? 'rolling' : 'walking'}: leg ${done} of ${path.length}`,
      })
    }
  }
  /** Runs a motion tool: it is the current call, and its state says it moves while it does. */
  const motion = async <T>(
    call: Call,
    gait: 'walk' | 'roll' | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    current = call
    try {
      if (model.unfolded > 0 && gait !== 'roll') await fold(call)
      moving = gait
      report()
      return await run()
    } finally {
      if (current === call) current = undefined
      moving = undefined
      model.want.wheel = false
      body.speed = 0
      report()
    }
  }

  dev.after = () => ({ pose: body.pose(), odometry: body.odometry() })
  // Manual walking: the latest axes, applied frame by frame; the deadman zeroes them (MAN-4).
  const manual = { vx: 0, wz: 0 }
  dev.onManual = (axes) => {
    manual.vx = axes.vx ?? 0
    manual.wz = axes.wz ?? 0
    moving = manual.vx !== 0 || manual.wz !== 0 ? 'walk' : undefined
    if (moving) model.want.wheel = false
    report()
  }
  dev.onStop = () => {
    body.speed = 0
    manual.vx = 0
    manual.wz = 0
    model.want.wheel = false
  }
  let manualAt = performance.now()
  let steering = false
  every(
    33,
    () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - manualAt) / 1000)
      manualAt = now
      if ((manual.vx === 0 && manual.wz === 0) || model.unfolded > 0) {
        if (steering) body.speed = body.turn = 0
        steering = false
        return
      }
      steering = true
      // The safety stop holds under manual control too: no walking forward into a boulder or a person.
      const vx = manual.vx > 0 && hazard('walk', Number.POSITIVE_INFINITY) ? 0 : manual.vx
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

  /** The way it stops, as an estop result. */
  const estop = (e: unknown) => {
    if (e instanceof Blocked)
      throw new CallError('estop', `${e.message}; now at ${where()}`, { data: { pose: body.pose() } })
    throw e
  }

  dev.tool(
    {
      name: 'go_to',
      description: `Go to a point on the base map (x east, y north, metres), finding its way around buildings, boulders and machines; to as near as it can get when the point itself is blocked. gait walk (${GAIT.walk.speed} m/s) goes anywhere; roll (${GAIT.roll.speed} m/s) only over open ground, ${MONO.clearance.roll} m clear of everything, and not while carrying. Stops by itself before a boulder, a machine or a person in its way.`,
      timeout: 300,
      params: {
        x: {
          type: 'number',
          minimum: MAP_AREA.x0,
          maximum: MAP_AREA.x1,
          description: 'metres east of the habitat',
        },
        y: {
          type: 'number',
          minimum: MAP_AREA.y0,
          maximum: MAP_AREA.y1,
          description: 'metres north of the habitat',
        },
        gait: {
          type: 'string',
          enum: ['walk', 'roll'],
          default: 'walk',
          description: 'walk, or roll as a wheel',
        },
      },
      required: ['x', 'y'],
      uses: ['slabs'],
      motion: true,
      pausable: true,
      ui: { label: 'Go to' },
    },
    (call, { x, y, gait }) =>
      motion(call, gait, async () => {
        if (gait === 'roll' && load)
          throw new CallError('x_carrying', `it cannot roll while it carries ${load.id}; walk (gait walk)`)
        const to = fromMap(x, y)
        const way = plan(to, gait)
        const start = performance.now()
        const odometer = body.odometer
        if (gait === 'roll') {
          model.want.wheel = true
          call.progress({ text: 'unfolding into a wheel' })
          await wait(call, UNFOLD_S * 1000 + 100)
        }
        await travel(call, way.path, gait, (remaining) => {
          const hit = hazard(gait, remaining)
          return hit ? describe(hit) : undefined
        }).catch(estop)
        if (gait === 'roll') {
          call.progress({ text: 'folding up' })
          await fold(call)
        }
        const missed = Math.hypot(way.end.x - to.x, way.end.z - to.z)
        const distance = round(body.odometer - odometer, 1)
        const seconds = Math.round((performance.now() - start) / 1000)
        return {
          detail: `${gait === 'roll' ? 'rolled' : 'walked'} ${distance} m in ${seconds} s to ${where()}${missed > 0.3 ? `, ${round(missed, 1)} m short of ${where(to)}, which is blocked` : ''}`,
          data: { gait, distance_m: distance, seconds, legs: way.path.length, route: way.path.map(toMap) },
        }
      }),
  )

  dev.tool(
    {
      name: 'follow',
      description: `Walk to a person or a moving device and stay with it: until beside it, or for \`seconds\` if given. It finds its way around buildings and boulders and comes within ${MONO.personGap} m of a person, ${MACHINE_GAP} m of a machine.`,
      timeout: 300,
      params: {
        target: { type: 'string', enum: FOLLOWABLE, description: 'the device or person (suit-01) to follow' },
        seconds: {
          type: 'number',
          minimum: 1,
          maximum: 240,
          description: 'keep following this long; omitted, it stops once beside the target',
        },
      },
      required: ['target'],
      uses: ['slabs'],
      motion: true,
      ui: { label: 'Follow' },
    },
    (call, { target, seconds }) =>
      motion(call, 'walk', async () => {
        if (target === 'suit-01' && load?.id === 'suit-01')
          throw new CallError('x_carrying', 'it is carrying suit-01 already')
        const find = () => world.things().find((t) => t.id === target)
        if (!find())
          throw new CallError(
            'x_not_here',
            `${target} is not outside: the astronaut is ${world.astronaut === 'inside' ? 'in the habitat' : 'in the airlock'}`,
          )
        const person = target === 'suit-01'
        const start = performance.now()
        const odometer = body.odometer
        const beside = (t: Thing) =>
          Math.hypot(t.x - body.at.x, t.z - body.at.z) - t.r - MONO.nose <=
          (person ? MONO.personGap + 0.3 : MACHINE_GAP)
        const until = seconds === undefined ? undefined : start + seconds * 1000
        for (;;) {
          const t = find()
          if (!t) throw new CallError('x_not_here', `${target} went where it cannot follow`)
          const near = beside(t)
          if (near && (until === undefined || performance.now() >= until)) break
          if (until !== undefined && performance.now() >= until) break
          if (near) {
            // Beside it: face it and wait for it to move on.
            body.speed = 0
            await turnTo(
              call,
              model.group,
              {
                y:
                  body.heading +
                  Math.atan2(
                    Math.sin(headingTo(body.at, t) - body.heading),
                    Math.cos(headingTo(body.at, t) - body.heading),
                  ),
              },
              300,
            )
            await wait(call, 300)
            continue
          }
          const way = plan({ x: t.x, z: t.z }, 'walk', [target as string])
          const before = body.odometer
          try {
            await travel(call, way.path, 'walk', (remaining) => {
              const hit = hazard('walk', remaining)
              if (hit?.id === target) return ARRIVED
              if (hit) return describe(hit)
              // The target moved on: plan again toward where it is now.
              const now = find()
              return now && Math.hypot(now.x - t.x, now.z - t.z) > REPLAN_M ? REPLAN : undefined
            })
          } catch (e) {
            if (!(e instanceof Blocked) || (e.message !== ARRIVED && e.message !== REPLAN)) estop(e)
            continue
          }
          if (body.odometer - before < 0.05 && !beside(find() ?? t))
            throw new CallError('x_no_way', `cannot get nearer to ${target} at ${where(t)} than ${where()}`)
        }
        const t = find() as Thing
        const gap = round(Math.max(0, Math.hypot(t.x - body.at.x, t.z - body.at.z) - t.r - MONO.nose), 1)
        const distance = round(body.odometer - odometer, 1)
        return {
          detail: `${seconds === undefined ? 'reached' : `followed for ${seconds} s and is beside`} ${target} at ${where(t)}, ${gap} m from it; walked ${distance} m, now at ${where()}`,
          data: { target, gap_m: gap, distance_m: distance, target_at: toMap(t) },
        }
      }),
  )

  dev.tool(
    {
      name: 'carry',
      description: `Pick up the astronaut (suit-01) or a sample of a rock (such as rock-1) within ${REACH} m of its front, and hold it. Carrying, it walks but cannot roll; put_down sets the load down, into the airlock's chamber or at the lab.`,
      timeout: 20,
      params: {
        target: {
          type: 'string',
          enum: ['suit-01', ...samples],
          description: 'the astronaut (suit-01) or a rock id from a survey',
        },
      },
      required: ['target'],
      uses: ['slabs'],
      motion: true,
      ui: { label: 'Carry' },
    },
    (call, { target }) =>
      motion(call, undefined, async () => {
        if (load) throw new CallError('x_hands_full', `it already carries ${load.id}; put_down first`)
        const person = target === 'suit-01'
        const t = person
          ? world.things().find((s) => s.id === 'suit-01')
          : OBSTACLES.find((o) => o.id === target)
        if (!t)
          throw new CallError(
            'x_not_here',
            `the astronaut is ${world.astronaut === 'inside' ? 'in the habitat' : 'in the airlock'}`,
          )
        const gap = Math.hypot(t.x - body.at.x, t.z - body.at.z) - t.r - MONO.nose
        if (gap > REACH)
          throw new CallError(
            'unreachable',
            `${target} is ${round(gap, 1)} m from its front, at ${where(t)}; ${person ? 'follow suit-01' : 'go_to it'} first, to within ${REACH} m`,
          )
        // Face the load, then lift it.
        const face = headingTo(body.at, t)
        await turnTo(
          call,
          model.group,
          { y: body.heading + Math.atan2(Math.sin(face - body.heading), Math.cos(face - body.heading)) },
          600,
        )
        if (person) {
          world.astronaut = 'carried'
          model.want.hold = 'astronaut'
          const from = astronaut.position.clone()
          const steps = (LIFT_S * 1000) / 33
          for (let i = 1; i <= steps; i++) {
            hold()
            const held = astronaut.position.clone()
            astronaut.position.lerpVectors(from, held, i / steps)
            await wait(call, 33)
          }
          load = { kind: 'astronaut', id: 'suit-01' }
          report()
          const said = speak(flavour(voice(LINES.pickup)))
          return {
            detail: `picked up the astronaut (suit-01) at ${where()}; holding them. Said: "${said}"`,
            data: { carrying: 'astronaut', target, said },
          }
        }
        call.progress({ text: `breaking off a sample of ${target}` })
        await wait(call, LIFT_S * 1000)
        const rock = OBSTACLES.find((o) => o.id === target)
        rock?.object.scale.multiplyScalar(0.85)
        model.want.hold = 'sample'
        load = { kind: 'sample', id: target as string }
        report()
        return {
          detail: `picked up a sample of ${target} at ${where(t)}; holding it for the lab`,
          data: { carrying: 'sample', target },
        }
      }),
  )

  dev.tool(
    {
      name: 'put_down',
      description: `Set down what it carries in front of it. At the airlock (within ${AT_AIRLOCK} m of its outer door, which must be open) it sets the astronaut into the chamber; a sample goes to the lab, within ${AT_LAB} m of it.`,
      timeout: 20,
      uses: ['slabs'],
      motion: true,
      ui: { label: 'Put down' },
    },
    (call) =>
      motion(call, undefined, async () => {
        if (!load) throw new CallError('x_empty', 'it carries nothing')
        const near = (p: readonly [number, number], r: number) =>
          Math.hypot(body.at.x - p[0], body.at.z - p[1]) <= r
        if (load.kind === 'sample') {
          if (!near(LAYOUT.lab, AT_LAB))
            throw new CallError(
              'x_not_at_lab',
              `samples go to the lab: go_to the lab (place lab, ${where({ x: LAYOUT.lab[0], z: LAYOUT.lab[1] })}) first`,
            )
          await wait(call, LIFT_S * 1000)
          const sample = load.id
          model.want.hold = 'none'
          load = undefined
          world.labReceive?.(sample)
          return {
            detail: `handed the sample of ${sample} to the lab; it waits there for analysis (lab-01 analyze)`,
            data: { put: sample, at: 'lab' },
          }
        }
        const atAirlock = near(LAYOUT.airlockDoor, AT_AIRLOCK)
        if (atAirlock && world.airlock.outer !== 'open')
          throw new CallError(
            'x_door_closed',
            "airlock-01's outer door is closed: cycle_out and open_outer there first, then put_down again",
          )
        // Set the astronaut down: into the chamber, or on the ground in front.
        const from = astronaut.position.clone()
        const h = body.heading
        const spot = atAirlock
          ? CHAMBER
          : {
              x: body.at.x + Math.sin(h) * (HELD.ahead + 0.1),
              z: body.at.z + Math.cos(h) * (HELD.ahead + 0.1),
            }
        const to = new THREE.Vector3(spot.x, world.ground(spot), spot.z)
        world.astronaut = atAirlock ? 'chamber' : 'standing'
        load = undefined
        const steps = (LIFT_S * 1000) / 33
        for (let i = 1; i <= steps; i++) {
          astronaut.position.lerpVectors(from, to, i / steps)
          await wait(call, 33)
        }
        astronaut.rotation.set(0, atAirlock ? Math.PI : h, 0)
        model.want.hold = 'none'
        world.airlockChanged?.()
        const said = speak(flavour(voice(atAirlock ? LINES.chamber : LINES.standing)))
        return {
          detail: atAirlock
            ? `set the astronaut (suit-01) into the airlock chamber; airlock-01 is occupied: close_outer, then cycle_in brings them into the habitat. Said: "${said}"`
            : `set the astronaut (suit-01) down at ${where(spot)}; they wait there. Said: "${said}"`,
          data: { put: 'suit-01', at: atAirlock ? 'airlock' : toMap(spot), said },
        }
      }),
  )

  dev.tool(
    {
      name: 'say',
      description:
        'Say something over the radio; it shows in a bubble over the robot. humor and honesty colour how it says it.',
      timeout: 20,
      params: { text: { type: 'string', maxLength: 200, description: 'what to say' } },
      required: ['text'],
      uses: ['radio'],
      ui: { label: 'Say' },
    },
    async (call, { text }) => {
      const said = speak(flavour(text as string))
      await wait(call, model.speech.until - performance.now())
      return { detail: `said over the radio: "${said}"`, data: { said, humor, honesty } }
    },
  )

  dev.tool(
    {
      name: 'stop',
      description: 'Stop where it is, ending whatever it is doing; it keeps hold of what it carries.',
      timeout: 5,
      ui: { label: 'Stop' },
    },
    async () => {
      const was = current?.name
      current?.interrupt('stop')
      dev.onStop?.()
      return {
        detail: `${was ? `stopped ${was}` : 'already standing still'}; at ${where()}${load ? `, holding ${load.id}` : ''}`,
        data: { stopped: was ?? null, carrying: load?.kind ?? 'none' },
      }
    },
  )
  world.onReset(() => {
    battery = 93
    humor = 75
    honesty = 90
    motor = -20
    load = undefined
    moving = undefined
    manual.vx = 0
    manual.wz = 0
    model.reset()
    body.reset()
    report()
  })
  return dev
}
