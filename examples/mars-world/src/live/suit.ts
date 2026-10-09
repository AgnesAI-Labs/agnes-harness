import * as THREE from 'three'
import { LAYOUT } from '../base.js'
import { addCamera } from './camera.js'
import { addPlace, reading } from './place.js'
import { headingTo } from './route.js'
import { Body, every, type World, WorldDevice } from './world.js'

/** The astronaut's walk: speed in m/s, turning in radians a second, metres per step. */
const WALK = { speed: 0.55, turn: 2.5, stride: 0.38 }

/**
 * The astronaut walks between the spots of the worksite on their own, working a while at each:
 * nobody commands them, and other devices must keep clear of them. A step bobs and sways the body.
 */
function wander(world: World, body: Body, log: (line: string) => void): void {
  const model = body.object
  const spots = LAYOUT.worksite
  let next = 1
  let restUntil = performance.now() + 6000
  let phase = 0
  let last = performance.now()
  every(
    33,
    () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (world.astronaut !== 'working' || now < restUntil) {
        body.speed = 0
        return
      }
      const [x, z] = spots[next] as readonly [number, number]
      const distance = Math.hypot(x - body.at.x, z - body.at.z)
      if (distance < 0.05) {
        next = (next + 1) % spots.length
        restUntil = now + 5000 + Math.random() * 7000
        body.speed = 0
        model.rotation.z = 0
        model.position.y = world.ground(body.at)
        return
      }
      let delta = headingTo(body.at, { x, z }) - model.rotation.y
      delta = Math.atan2(Math.sin(delta), Math.cos(delta))
      model.rotation.y += Math.sign(delta) * Math.min(Math.abs(delta), WALK.turn * dt)
      const step = Math.abs(delta) < 0.4 ? Math.min(distance, WALK.speed * dt) : 0
      model.position.x += Math.sin(model.rotation.y) * step
      model.position.z += Math.cos(model.rotation.y) * step
      body.odometer += step
      body.speed = step / Math.max(dt, 1e-3)
      phase += (step / WALK.stride) * Math.PI
      model.position.y = world.ground(body.at) + Math.abs(Math.sin(phase)) * 0.05
      model.rotation.z = Math.sin(phase) * 0.05
    },
    log,
  )
}

/** The astronaut's suit: its supplies, the wearer's vital signs, a helmet camera and where it is. */
export function suit(
  world: World,
  options: { id: string; name: string; model: THREE.Object3D; o2: number; battery: number; working: boolean },
  log: (line: string) => void,
): WorldDevice {
  const body = new Body(options.model, world)
  let o2 = options.o2
  let battery = options.battery
  const dev = new WorldDevice({
    id: options.id,
    kind: 'wearable',
    name: options.name,
    model: 'Agnes Base EVA suit',
    mobile: true,
    localization: 'self',
    profile: {
      notes:
        "A pressure suit worn outside the base. It reports its supplies and the wearer's vital signs; it takes no commands. The wearer moves about on their own: keep vehicles clear of them.",
    },
    state: {
      o2_left: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        role: 'consumable',
        of: 'oxygen',
        alert: { warn: 30, bad: 15, below: true },
        description: 'oxygen left in the tanks',
      },
      battery: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        role: 'battery',
        alert: { warn: 25, bad: 10, below: true },
      },
      comm: { type: 'string', enum: ['ok', 'weak', 'lost'], description: 'the suit radio link to the base' },
    },
    ui: { primary: 'helmet_video' },
  })
  dev.log = log
  const report = () => dev.update({ o2_left: Math.round(o2), battery: Math.round(battery), comm: 'ok' })
  report()

  const vitals = dev.source('vitals', 'values', "the wearer's vital signs", {
    hz: 1,
    default: true,
    fields: {
      heart_rate: {
        type: 'integer',
        unit: 'bpm',
        min: 40,
        max: 200,
        role: 'heart_rate',
        alert: { warn: 120, bad: 150 },
      },
      body_temperature: {
        type: 'number',
        unit: '°C',
        min: 34,
        max: 41,
        role: 'body_temperature',
        alert: { warn: 38, bad: 39 },
      },
      spo2: {
        type: 'integer',
        unit: '%',
        min: 70,
        max: 100,
        role: 'spo2',
        alert: { warn: 93, bad: 88, below: true },
      },
    },
  })
  const life = dev.source('life_support', 'values', 'pressure, CO2 and temperature inside the suit', {
    hz: 1,
    fields: {
      pressure: {
        type: 'number',
        unit: 'kPa',
        min: 20,
        max: 35,
        alert: { warn: 27, bad: 25, below: true },
        description: 'suit pressure',
      },
      co2: { type: 'integer', unit: 'ppm', min: 0, max: 20000, alert: { warn: 5000, bad: 10000 } },
      temperature: { type: 'number', unit: '°C', min: 10, max: 35, role: 'temperature', of: 'suit' },
    },
  })
  // The helmet camera, just in front of the visor.
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 1500)
  cam.rotation.set(-0.15, Math.PI, 0, 'YXZ')
  cam.position.set(0, 1.62, 0.5)
  options.model.add(cam)
  addCamera(
    dev,
    world,
    cam,
    {
      id: 'helmet',
      description: 'helmet camera, looking where the wearer looks',
      mount: { xyz: [0.5, 0, 1.62], rpy: [0, 9, 0] },
      default: true,
    },
    log,
  )
  addPlace(dev, world, body, { what: 'astronaut', maxError: 2, hz: 1 }, log)
  wander(world, body, log)

  every(
    1000,
    () => {
      const t = performance.now() / 1000
      const effort = options.working ? 1 : 0
      if (vitals.wants())
        vitals.send({
          heart_rate: Math.round(78 + effort * 22 + Math.sin(t / 17) * 5 + Math.random() * 3),
          body_temperature: reading(36.8 + effort * 0.3, 0.05),
          spo2: Math.round(97 + Math.random() * 1.5),
        })
      if (life.wants())
        life.send({
          pressure: reading(29.6, 0.05),
          co2: Math.round(1800 + effort * 900 + Math.random() * 100),
          temperature: reading(21 + effort * 1.5, 0.2),
        })
    },
    log,
  )
  // Supplies run down slowly: oxygen faster while working outside.
  every(
    10000,
    () => {
      o2 = Math.max(0, o2 - (options.working ? 0.25 : 0.1))
      battery = Math.max(0, battery - 0.1)
      report()
    },
    log,
  )
  world.onReset(() => {
    o2 = options.o2
    battery = options.battery
    body.reset()
    options.model.visible = true
    report()
  })
  return dev
}
