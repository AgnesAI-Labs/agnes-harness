import type { Call } from '@agnes/mhs/device'
import * as THREE from 'three'
import { LAYOUT } from '../base.js'
import { placed } from './basemap.js'
import { addCamera } from './camera.js'
import { reading } from './place.js'
import { every, turnTo, type World, WorldDevice, wait } from './world.js'

/** Places the camera can be pointed at by name, in world coordinates. */
const PRESETS: Record<string, readonly [number, number]> = {
  base: [2, -2],
  'hopper pad': LAYOUT.hopperPad,
  dock: LAYOUT.dock,
  airlock: LAYOUT.airlockDoor,
  'landing pad': LAYOUT.landingPad,
  'west field': LAYOUT.field,
}
const FOV = 50

/** The base camera on its mast: pans, tilts and zooms to check the pads, the dock and the airlock. */
export function baseCamera(world: World, log: (line: string) => void): WorldDevice {
  const head = world.parts.camHead
  head.rotation.order = 'YXZ'
  const at = head.getWorldPosition(new THREE.Vector3())
  /** Pan 0 looks north over the base; positive pans left (west), positive tilt looks up. */
  const NORTH = Math.PI
  const aim = (x: number, z: number) => ({
    pan: THREE.MathUtils.radToDeg(Math.atan2(x - at.x, z - at.z) - NORTH),
    tilt: THREE.MathUtils.radToDeg(Math.atan2(world.ground({ x, z }) - at.y, Math.hypot(x - at.x, z - at.z))),
  })
  const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180
  let pan = 0
  let tilt = 0
  let zoom = 1
  let preset = 'base'
  const dev = new WorldDevice({
    id: 'cam-base',
    kind: 'camera',
    name: 'Base camera',
    model: 'Agnes Base mast camera',
    localization: 'fixed',
    // Unpanned, it looks north over the base.
    placement: placed(LAYOUT.camBase, 90),
    profile: {
      notes:
        'Pan-tilt-zoom camera on a 6 m mast south of the base, for checking pads, the dock and the airlock.',
    },
    resources: { head: 'reject' },
    state: {
      preset: {
        type: 'string',
        enum: [...Object.keys(PRESETS), 'manual'],
        description: 'what it is pointed at',
      },
      pan: {
        type: 'number',
        unit: 'deg',
        min: -170,
        max: 170,
        description: '0 looks north over the base, positive left',
      },
      tilt: { type: 'number', unit: 'deg', min: -60, max: 20, description: 'positive looks up' },
      zoom: { type: 'number', min: 1, max: 4, description: 'magnification' },
    },
    ui: { primary: 'view_video' },
  })
  dev.log = log
  const cam = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 2000)
  // The lens is on the head's +z side; a camera looks along its own -z.
  cam.rotation.y = Math.PI
  cam.position.z = 0.3
  head.add(cam)
  addCamera(
    dev,
    world,
    cam,
    {
      id: 'view',
      description: 'the mast camera, wherever it is pointed',
      mount: { xyz: [0.3, 0, 0], rpy: [0, 0, 0] },
      default: true,
    },
    log,
  )
  const health = dev.source('housing', 'values', 'the camera housing', {
    hz: 0.5,
    fields: {
      temperature: {
        type: 'number',
        unit: '°C',
        min: -60,
        max: 70,
        role: 'temperature',
        of: 'housing',
        alert: { warn: 50, bad: 60 },
      },
    },
  })
  every(2000, () => void (health.wants() && health.send({ temperature: reading(4, 0.3) })), log)

  const report = () =>
    dev.update({ preset, pan: Math.round(pan * 10) / 10, tilt: Math.round(tilt * 10) / 10, zoom })
  const point = async (call: Call, p: number, t: number) => {
    const ms = 300 + Math.max(Math.abs(p - pan), Math.abs(t - tilt)) * 12
    await turnTo(call, head, { y: NORTH + THREE.MathUtils.degToRad(p), x: THREE.MathUtils.degToRad(-t) }, ms)
    pan = p
    tilt = t
  }
  const start = aim(...(PRESETS.base as [number, number]))
  pan = wrap(start.pan)
  tilt = start.tilt
  head.rotation.set(THREE.MathUtils.degToRad(-tilt), NORTH + THREE.MathUtils.degToRad(pan), 0)
  report()

  dev.tool(
    {
      name: 'look_at',
      description: `Point the camera at a named place (${Object.keys(PRESETS).join(', ')}), or to a pan and tilt in degrees.`,
      timeout: 15,
      params: {
        preset: { type: 'string', enum: Object.keys(PRESETS), description: 'a named place' },
        pan: {
          type: 'number',
          minimum: -170,
          maximum: 170,
          description: 'degrees, 0 north over the base, positive left',
        },
        tilt: { type: 'number', minimum: -60, maximum: 20, description: 'degrees, positive up' },
      },
      uses: ['head'],
      motion: true,
      ui: { label: 'Look at' },
    },
    async (call, args) => {
      const target = args.preset
        ? aim(...(PRESETS[args.preset as string] as [number, number]))
        : { pan: args.pan ?? pan, tilt: args.tilt ?? tilt }
      await point(call, wrap(target.pan), Math.max(-60, Math.min(20, target.tilt)))
      preset = (args.preset as string | undefined) ?? 'manual'
      report()
      return `looking at ${preset === 'manual' ? `pan ${Math.round(pan)}°, tilt ${Math.round(tilt)}°` : `the ${preset}`}`
    },
  )
  dev.tool(
    {
      name: 'zoom',
      description: 'Zoom the camera in or out.',
      timeout: 10,
      params: { level: { type: 'number', minimum: 1, maximum: 4, description: 'magnification, 1 to 4' } },
      required: ['level'],
      uses: ['head'],
      ui: { label: 'Zoom' },
    },
    async (call, { level }) => {
      const from = zoom
      for (let i = 1; i <= 10; i++) {
        await wait(call, 60)
        zoom = from + (level - from) * (i / 10)
        cam.fov = FOV / zoom
        cam.updateProjectionMatrix()
      }
      zoom = level
      report()
      return `zoom ${level}×`
    },
  )
  world.onReset(() => {
    pan = wrap(start.pan)
    tilt = start.tilt
    zoom = 1
    cam.fov = FOV
    cam.updateProjectionMatrix()
    preset = 'base'
    head.rotation.set(THREE.MathUtils.degToRad(-tilt), NORTH + THREE.MathUtils.degToRad(pan), 0)
    report()
  })
  return dev
}
