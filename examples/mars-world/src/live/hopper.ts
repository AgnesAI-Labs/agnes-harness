import { type Call, CallError } from '@agnes/mhs/device'
import * as THREE from 'three'
import { LAYOUT } from '../base.js'
import { OBSTACLES } from '../terrain.js'
import { addCamera } from './camera.js'
import { addPlace, reading } from './place.js'
import { burn, flightTimeLeft, maxAltitude, ROCKET } from './rocket.js'
import { type Circle, fromMap, type Point, pathToRock, ROVER, round, toMap } from './route.js'
import { Blocked, Body, every, type Thing, type World, WorldDevice, wait } from './world.js'

/** Named areas the hopper can survey: centre and radius in world coordinates. */
export const AREAS: Record<string, Point & { r: number }> = {
  'west field': { x: -38, z: 36, r: 12 },
  'east dunes': { x: 62, z: 8, r: 14 },
}
/** Standing on its pad, the hopper's base is this far above the ground. */
const PAD_TOP = 0.12
/** Pads it can land on: where, and how high their top is above the ground. */
const PADS: Record<string, { at: readonly [number, number]; top: number }> = {
  'hopper pad': { at: LAYOUT.hopperPad, top: PAD_TOP },
  'landing pad': { at: LAYOUT.landingPad, top: 0.2 },
}
/** Flight: top speed and acceleration, climb and descent rates, turning in radians a second. */
const FLIGHT = { speed: 10, accel: 3.5, climb: 4, descend: 3, turn: Math.PI }
const SURVEY_ALT = 12
/** Half the ground the downward camera covers at survey height. */
const FOOTPRINT = 8
/** Seconds the engine takes to light and reach lift-off thrust. */
const IGNITION_S = 1.2

/**
 * The rocket hopper: flies on a methane-oxygen engine, so it needs no air. It hovers, hops between
 * points, surveys an area from above and finds a way for the rover. Propellant limits how long and
 * how high it flies; it refuels only on its own pad.
 */
export function hopper(world: World, log: (line: string) => void): WorldDevice {
  const { hopper: model, thrust } = world.parts
  const body = new Body(model, world, PAD_TOP)
  let propellant = 100
  let battery = 88
  let bay = -12
  /** In the air, from lift-off until touchdown. */
  let airborne = false
  /** Tools that fly; while none runs, a hopper at its landing reserve lands where it is. */
  let flying = 0
  const altitude = () => Math.max(0, round(model.position.y - world.ground(body.at) - PAD_TOP, 1))
  const onPad = () => {
    const [x, z] = LAYOUT.hopperPad
    return !airborne && Math.hypot(body.at.x - x, body.at.z - z) < 1.5
  }
  const dev = new WorldDevice({
    id: 'hopper-01',
    kind: 'hopper',
    name: 'Hopper',
    model: 'Agnes Base rocket hopper',
    mobile: true,
    localization: 'self',
    profile: {
      size_m: [2.6, 2.6, 2.2],
      weight_kg: 240,
      max_speed: FLIGHT.speed,
      runtime_min: Math.round(flightTimeLeft(100) / 6) / 10,
      notes: `A small rocket lander on four legs that flies on a methane-oxygen engine, so it needs no air. It takes off, hovers, hops to points and lands again. Propellant (percent of a full load) sets the limits: hovering burns ${ROCKET.hoverBurn} % a second, moving and climbing more; ${ROCKET.reserve} % is kept for landing; take-off needs ${ROCKET.minTakeOff} %; flight_time_left and max_altitude in its state follow from what is left (at most ${ROCKET.ceiling} m above the ground). It refuels only while landed on the hopper pad, ${ROCKET.refuel} % a second. It does not fly under a dust storm warning at weather-01. Stopped in the air, it hovers; on reaching the landing reserve with nothing to do, it lands where it is. Keep people clear of its pad when it lands.`,
    },
    resources: { engine: 'reject' },
    ui: { primary: 'down_video' },
    state: {
      mode: {
        type: 'string',
        enum: ['landed', 'hovering', 'flying'],
        description: 'on the ground, holding position in the air, or moving',
      },
      propellant: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        role: 'consumable',
        of: 'propellant',
        alert: { warn: 35, bad: 20, below: true },
        description: 'propellant left, percent of a full load',
      },
      flight_time_left: {
        type: 'integer',
        unit: 's',
        min: 0,
        max: flightTimeLeft(100),
        description: 'seconds it could still hover before reaching the landing reserve',
      },
      max_altitude: {
        type: 'integer',
        unit: 'm',
        min: 0,
        max: ROCKET.ceiling,
        description: 'the highest it can fly now, metres above the ground, from the propellant left',
      },
      battery: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        role: 'battery',
        alert: { warn: 25, bad: 10, below: true },
      },
      temperature: {
        type: 'number',
        unit: '°C',
        min: -60,
        max: 120,
        role: 'temperature',
        of: 'engine',
        alert: { warn: 70, bad: 90 },
        description: 'engine bay temperature',
      },
      refueling: { type: 'boolean', description: 'landed on the hopper pad, taking on propellant' },
    },
  })
  dev.log = log
  const report = () =>
    dev.update({
      propellant: Math.round(propellant),
      flight_time_left: flightTimeLeft(propellant),
      max_altitude: maxAltitude(propellant),
      battery: Math.round(battery),
      temperature: round(bay, 1),
      refueling: onPad() && propellant < 100,
    })
  dev.update({ mode: 'landed' })
  report()

  const down = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 2000)
  down.position.set(0.45, 0.82, 0.3)
  down.rotation.x = -Math.PI / 2
  model.add(down)
  addCamera(
    dev,
    world,
    down,
    {
      id: 'down',
      description: 'downward camera under the deck, looking straight down',
      mount: { xyz: [0.3, -0.45, 0.82], rpy: [0, 90, 0] },
      default: true,
    },
    log,
  )
  const front = new THREE.PerspectiveCamera(55, 16 / 9, 0.05, 2000)
  front.rotation.order = 'YXZ'
  front.rotation.set(-0.26, Math.PI, 0)
  front.position.set(0, 0.9, 0.82)
  model.add(front)
  addCamera(
    dev,
    world,
    front,
    {
      id: 'front',
      description: 'forward camera under the front of the deck, looking ahead and 15 degrees down',
      mount: { xyz: [0.82, 0, 0.9], rpy: [0, 15, 0] },
    },
    log,
  )
  addPlace(dev, world, body, { what: 'hopper', maxError: 0.5 }, log)
  const telemetry = dev.source('telemetry', 'values', 'flight telemetry: height, thrust, tanks, power', {
    hz: 2,
    fields: {
      altitude: {
        type: 'number',
        unit: 'm',
        min: 0,
        max: ROCKET.ceiling + 5,
        description: 'height above the ground',
      },
      thrust: { type: 'number', unit: '%', min: 0, max: 100, description: 'engine thrust' },
      tank_pressure: {
        type: 'number',
        unit: 'kPa',
        min: 0,
        max: 3000,
        alert: { warn: 1400, bad: 1000, below: true },
        description: 'propellant tank pressure',
      },
      voltage: { type: 'number', unit: 'V', min: 22, max: 30, role: 'voltage', of: 'main' },
      engine_temperature: {
        type: 'number',
        unit: '°C',
        min: -60,
        max: 120,
        role: 'temperature',
        of: 'engine',
        alert: { warn: 70, bad: 90 },
      },
    },
  })

  // Ten times a second: burn propellant in the air and set the thrust from how it moves; refuel
  // and charge on the pad.
  let lastY = model.position.y
  let lastT = performance.now()
  let landing = false
  every(
    100,
    () => {
      const now = performance.now()
      const dt = Math.min(0.5, (now - lastT) / 1000)
      lastT = now
      const climbed = model.position.y - lastY
      lastY = model.position.y
      if (airborne) {
        propellant = Math.max(0, propellant - burn(dt, body.speed, climbed))
        battery = Math.max(0, battery - 0.05 * dt)
        bay += (55 - bay) * 0.02 * dt * 10
        const target = Math.max(0.3, Math.min(1, 0.55 + (climbed / dt) * 0.1 + body.speed * 0.02))
        thrust.level += (target - thrust.level) * 0.5
        // At the landing reserve with nothing to do, it comes down where it is.
        if (flying === 0 && flightTimeLeft(propellant) === 0 && !landing) {
          landing = true
          dev.update({ mode: 'flying' })
          dev.problem = 'propellant at the landing reserve; landing where it is'
        }
        if (landing && flying === 0) {
          model.position.y = Math.max(world.ground(body.at) + PAD_TOP, model.position.y - FLIGHT.descend * dt)
          if (altitude() < 0.02) touchdown()
        }
      } else {
        bay += (-12 - bay) * 0.005 * dt * 10
        if (onPad()) {
          propellant = Math.min(100, propellant + ROCKET.refuel * dt)
          battery = Math.min(100, battery + 0.2 * dt)
        }
      }
    },
    log,
  )
  every(1000, report, log)
  every(
    500,
    () => {
      if (!telemetry.wants()) return
      telemetry.send({
        altitude: altitude(),
        thrust: Math.round(thrust.level * 100),
        tank_pressure: reading(1200 + propellant * 10, 5, 0),
        voltage: reading(24 + battery * 0.05, 0.05, 2),
        engine_temperature: reading(bay, 0.3),
      })
    },
    log,
  )

  const touchdown = () => {
    airborne = false
    landing = false
    thrust.level = 0
    dev.update({ mode: 'landed' })
    dev.problem = null
    report()
  }

  dev.after = () => ({ pose: body.pose(), odometry: body.odometry() })
  // Stop means hold position: a rocket in the air cannot simply cut its engine.
  dev.onStop = () => {
    body.speed = 0
  }
  dev.unsafe = (tool) => {
    if (tool === 'land')
      return airborne ? undefined : 'already on the ground; take_off first to fly to another pad'
    if (tool === 'take_off') {
      if (airborne) return 'already in the air'
      if (propellant < ROCKET.minTakeOff)
        return `propellant ${Math.round(propellant)} %, under the ${ROCKET.minTakeOff} % a take-off needs; it refuels on the hopper pad`
    } else if (!airborne) return 'on the ground; take_off first'
    else if (flightTimeLeft(propellant) < 10)
      return `propellant ${Math.round(propellant)} %, at the landing reserve; land now`
    if (world.weather.storm === 'warning')
      return 'dust storm warning at weather-01; no flying in a dust storm'
    return undefined
  }

  /** Whatever ended a flight leg, a hopper in the air is hovering afterwards. */
  const settle = () => {
    if (airborne) dev.update({ mode: 'hovering' })
  }
  /** Runs a flying tool: counted, so the reserve check leaves it alone, and settled afterwards. */
  const flight = async <T>(run: () => Promise<T>): Promise<T> => {
    flying += 1
    try {
      return await run()
    } finally {
      flying -= 1
      settle()
    }
  }
  const climb = async (call: Call, to: number) => {
    const ceiling = maxAltitude(propellant)
    if (to > ceiling)
      throw new CallError(
        'x_too_high',
        `${to} m is over the ${ceiling} m the ${Math.round(propellant)} % of propellant allows`,
      )
    if (!airborne) {
      call.progress({ text: 'igniting the engine' })
      const steps = IGNITION_S * 10
      try {
        for (let i = 1; i <= steps; i++) {
          await wait(call, 100)
          thrust.level = 0.9 * (i / steps)
        }
      } catch (e) {
        thrust.level = 0
        throw e
      }
      airborne = true
      dev.problem = null
    }
    dev.update({ mode: 'flying' })
    await body.rise(call, world.ground(body.at) + PAD_TOP + to, FLIGHT.climb, undefined, 3)
  }
  /**
   * Flies to `p` at the altitude it holds now, reporting progress. Only landing may go on into the
   * landing reserve; anything else ends there.
   */
  const flyTo = async (call: Call, p: Point, label: string, step?: () => void, useReserve = false) => {
    dev.update({ mode: 'flying' })
    const cruise = altitude()
    const total = Math.max(0.1, Math.hypot(p.x - body.at.x, p.z - body.at.z))
    let told = 0
    try {
      await body.go(call, p, {
        speed: FLIGHT.speed,
        accel: FLIGHT.accel,
        turnRate: FLIGHT.turn,
        arrive: 0.3,
        height: (q) => world.ground(q) + PAD_TOP + cruise,
        blocked: () =>
          !useReserve && flightTimeLeft(propellant) === 0 ? 'propellant at the landing reserve' : undefined,
        step: () => {
          step?.()
          const now = performance.now()
          if (now - told < 500) return
          told = now
          const left = Math.hypot(p.x - body.at.x, p.z - body.at.z)
          call.progress({
            done: round(1 - left / total, 2),
            total: 1,
            text: `${label}: ${round(left, 0)} m to go`,
          })
        },
      })
    } catch (e) {
      if (e instanceof Blocked)
        throw new CallError(
          'x_propellant_low',
          `propellant down to the ${ROCKET.reserve} % landing reserve; hovering, land now`,
        )
      throw e
    }
  }

  dev.tool(
    {
      name: 'take_off',
      description: `Light the engine, lift off and climb to an altitude above the ground, then hover. Needs at least ${ROCKET.minTakeOff} % propellant; the altitude may not exceed max_altitude in the state.`,
      timeout: 20,
      params: {
        alt: {
          type: 'number',
          minimum: 2,
          maximum: ROCKET.ceiling,
          default: 6,
          description: 'altitude above the ground, metres',
        },
      },
      uses: ['engine'],
      motion: true,
      ui: { label: 'Take off' },
    },
    (call, { alt }) =>
      flight(async () => {
        await climb(call, alt)
        return `took off, hovering at ${altitude()} m with ${Math.round(propellant)} % propellant`
      }),
  )
  dev.tool(
    {
      name: 'fly_to',
      description:
        'Fly to a point on the base map and hover over it, at the current altitude or a new one. Reports progress as the distance left.',
      timeout: 60,
      params: {
        x: { type: 'number', minimum: -150, maximum: 150, description: 'metres east of the habitat' },
        y: { type: 'number', minimum: -150, maximum: 150, description: 'metres north of the habitat' },
        alt: {
          type: 'number',
          minimum: 2,
          maximum: ROCKET.ceiling,
          description: 'new altitude above the ground, metres; at most max_altitude',
        },
      },
      required: ['x', 'y'],
      uses: ['engine'],
      motion: true,
      pausable: true,
      ui: { label: 'Fly to' },
    },
    (call, { x, y, alt }) =>
      flight(async () => {
        if (alt !== undefined) await climb(call, alt)
        await flyTo(call, fromMap(x, y), 'flying')
        return `hovering over (${round(x, 1)}, ${round(y, 1)}) at ${altitude()} m`
      }),
  )
  dev.tool(
    {
      name: 'survey',
      description: `Fly over a named area at ${SURVEY_ALT} m, look down, and report what is there with map coordinates: unusual rocks, boulders, people. For an unusual rock, data.route is a route a rover can drive from the dock to within reach of it, around everything in the way. Ends hovering over the area.`,
      timeout: 120,
      params: {
        area: { type: 'string', enum: Object.keys(AREAS), description: 'the area to survey' },
      },
      required: ['area'],
      uses: ['engine'],
      motion: true,
      pausable: true,
      ui: { label: 'Survey' },
    },
    (call, { area }) =>
      flight(async () => {
        const a = AREAS[area as string] as Point & { r: number }
        if (altitude() < SURVEY_ALT - 0.5) await climb(call, SURVEY_ALT)
        // What lies under the hopper, within the downward camera's footprint (the scene's truth).
        const seen = new Map<string, Thing>()
        const look = () => {
          for (const t of world.things())
            if (
              t.label !== 'hopper' &&
              t.label !== 'rover' &&
              Math.hypot(t.x - body.at.x, t.z - body.at.z) < FOOTPRINT
            )
              seen.set(t.id, t)
        }
        await flyTo(call, a, `flying to the ${area}`, look)
        for (let i = 0; i <= 8; i++) {
          const k = (i / 8) * Math.PI * 2
          await flyTo(
            call,
            { x: a.x + Math.cos(k) * a.r * 0.6, z: a.z + Math.sin(k) * a.r * 0.6 },
            'surveying',
            look,
          )
          call.progress({ done: i + 1, total: 10, text: `surveying the ${area}: ${seen.size} things seen` })
        }
        await flyTo(call, a, 'surveying', look)
        const found = [...seen.values()].map((t) => ({
          id: t.id,
          label: t.label,
          ...toMap(t),
          size_m: round(t.r * 2, 1),
        }))
        const rocks = found.filter((f) => f.label === 'unusual rock')
        const boulders = found.filter((f) => f.label === 'boulder')
        const people = found.filter((f) => f.label === 'astronaut')
        const data: Record<string, unknown> = { area, found }
        const parts = [
          rocks.length
            ? rocks.map((r) => `unusual rock ${r.id} at (${r.x}, ${r.y})`).join(', ')
            : 'no unusual rock',
          `${boulders.length} boulders`,
          people.length ? `${people.length} astronaut${people.length > 1 ? 's' : ''}` : 'nobody',
        ]
        const target = rocks[0]
        if (target) {
          // A route the rover can drive from the dock to beside the rock, keeping its stop distance
          // from every boulder and person, planned on the same base map the rover plans on.
          const dock = { x: LAYOUT.dock[0], z: LAYOUT.dock[1] + 0.4 }
          const { stops, others } = world.inTheWay([target.id])
          const rock = OBSTACLES.find((o) => o.id === target.id) as Circle
          const legs = pathToRock(world.planGrid(), dock, rock, stops, others)
          if (legs) {
            const route = legs.map(toMap)
            data.route = route
            parts.push(
              `a rover route from the dock to beside ${target.id} in ${route.length} legs keeps ${ROVER.stopClearance} m from boulders and people`,
            )
          } else parts.push(`no rover route from the dock to ${target.id} keeps clear of the boulders`)
        }
        return { detail: `surveyed the ${area}: ${parts.join(', ')}`, data }
      }),
  )
  dev.tool(
    {
      name: 'land',
      description: 'Fly to a pad and land on it. It refuels only on the hopper pad.',
      timeout: 60,
      params: {
        pad: { type: 'string', enum: Object.keys(PADS), default: 'hopper pad', description: 'where to land' },
      },
      uses: ['engine'],
      motion: true,
      ui: { label: 'Land' },
    },
    (call, { pad }) =>
      flight(async () => {
        const { at, top } = PADS[pad as string] as { at: readonly [number, number]; top: number }
        await flyTo(call, { x: at[0], z: at[1] }, `flying to the ${pad}`, undefined, true)
        call.progress({ text: `descending onto the ${pad}` })
        await body.rise(call, world.ground(body.at) + top, FLIGHT.descend, undefined, 2)
        touchdown()
        return `landed on the ${pad} with ${Math.round(propellant)} % propellant${pad === 'hopper pad' ? '; refueling' : ''}`
      }),
  )
  world.onReset(() => {
    propellant = 100
    battery = 88
    bay = -12
    airborne = false
    landing = false
    thrust.level = 0
    body.reset()
    dev.update({ mode: 'landed' })
    dev.problem = null
    report()
  })
  return dev
}
