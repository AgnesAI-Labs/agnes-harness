import { type Call, CallError } from '@agnes/mhs/device'
import * as THREE from 'three'
import { LAYOUT } from '../base.js'
import { placed } from './basemap.js'
import { addCamera } from './camera.js'
import { reading } from './place.js'
import { every, turnTo, type World, WorldDevice, wait } from './world.js'

/** What the lab finds in each sample the base knows about. */
const FINDINGS: Record<string, { minerals: Record<string, number>; verdict: string }> = {
  'rock-1': {
    minerals: { olivine: 41, pyroxene: 22, carbonate: 9, plagioclase: 18, other: 10 },
    verdict:
      'olivine-rich basalt with carbonate veins: water once flowed through it; a candidate for return to Earth',
  },
}

/** The lab: its arm takes samples off the docked rover, then the lab analyzes them. */
export function lab(world: World, log: (line: string) => void): WorldDevice {
  const queue: string[] = []
  const [base, shoulder, elbow] = world.parts.arm.joints as [THREE.Object3D, THREE.Object3D, THREE.Object3D]
  const dev = new WorldDevice({
    id: 'lab-01',
    kind: 'lab',
    name: 'Lab',
    model: 'Agnes Base sample lab',
    localization: 'fixed',
    // Its arm reaches east, over the docked rover.
    placement: placed(LAYOUT.lab, 0),
    resources: { arm: 'reject', analyzer: 'reject' },
    ui: { primary: 'arm_video' },
    state: {
      mode: { type: 'string', enum: ['idle', 'unloading', 'analyzing'] },
      queue: { type: 'integer', min: 0, max: 20, description: 'samples waiting for analysis' },
      last_result: { type: 'string', description: 'the last analysis, one sentence' },
    },
  })
  dev.log = log
  dev.update({ mode: 'idle', queue: 0, last_result: 'nothing analyzed yet' })

  // A camera on the wrist, looking along the gripper.
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.03, 300)
  cam.rotation.x = Math.PI / 2
  cam.position.set(0, 0.32, 0.02)
  world.parts.arm.wrist.add(cam)
  addCamera(
    dev,
    world,
    cam,
    {
      id: 'arm',
      description: "camera on the arm's wrist, looking along the gripper",
      mount: { xyz: [0, 0, 0], rpy: [0, 90, 0] },
      default: true,
    },
    log,
  )
  const room = dev.source('room', 'values', 'the lab module and its analyzer', {
    hz: 1,
    fields: {
      temperature: { type: 'number', unit: '°C', min: 10, max: 35, role: 'temperature', of: 'air' },
      pressure: {
        type: 'number',
        unit: 'kPa',
        min: 90,
        max: 105,
        alert: { warn: 96, bad: 92, below: true },
        description: 'cabin pressure',
      },
      analyzer_temperature: {
        type: 'number',
        unit: '°C',
        min: 15,
        max: 1100,
        role: 'temperature',
        of: 'analyzer',
        description: 'the analyzer oven, hot while it analyzes',
      },
    },
  })
  let oven = 22
  every(
    1000,
    () => {
      oven += dev.state.mode === 'analyzing' ? (900 - oven) * 0.25 : (22 - oven) * 0.08
      if (!room.wants()) return
      room.send({
        temperature: reading(21.5, 0.2),
        pressure: reading(101.2, 0.1),
        analyzer_temperature: reading(oven, 1, 0),
      })
    },
    log,
  )
  // Monolith hands samples to the lab at its sample port.
  world.labReceive = (sample) => {
    queue.push(sample)
    dev.update({ queue: queue.length })
  }
  dev.unsafe = (tool) => {
    if (tool !== 'unload_rover') return undefined
    if (!world.rover.docked) return 'the rover is not in the dock'
    if (world.rover.cargo.length === 0) return 'the rover has no samples on board'
    return undefined
  }
  dev.onStop = () => {
    world.parts.arm.busy = false
  }

  const rest = (call: Call) =>
    Promise.all([
      turnTo(call, base, { y: 0 }, 900),
      turnTo(call, shoulder, { z: -0.55 }, 900),
      turnTo(call, elbow, { z: 1.25 }, 900),
    ])

  dev.tool(
    {
      name: 'unload_rover',
      description: 'Take every sample off the docked rover with the arm and queue it for analysis.',
      timeout: 20,
      uses: ['arm'],
      motion: true,
    },
    async (call) => {
      world.parts.arm.busy = true
      dev.update({ mode: 'unloading' })
      try {
        await turnTo(call, base, { y: -Math.PI / 2 }, 900)
        await Promise.all([turnTo(call, shoulder, { z: -1.0 }, 1200), turnTo(call, elbow, { z: -1.1 }, 1200)])
        call.progress({ done: 1, total: 2, text: 'gripping the sample container' })
        await wait(call, 800)
        const taken = world.rover.cargo.splice(0)
        world.roverChanged?.()
        await rest(call)
        queue.push(...taken)
        dev.update({ queue: queue.length })
        return {
          detail: `unloaded ${taken.join(', ')}; ${queue.length} waiting for analysis`,
          data: { samples: taken },
        }
      } finally {
        world.parts.arm.busy = false
        dev.update({ mode: 'idle' })
      }
    },
  )
  dev.tool(
    {
      name: 'analyze',
      description: 'Analyze a queued sample: what minerals it holds and what that means.',
      timeout: 20,
      params: { sample: { type: 'string', maxLength: 40 } },
      required: ['sample'],
      uses: ['analyzer'],
    },
    async (call, { sample }) => {
      const at = queue.indexOf(sample as string)
      if (at < 0)
        throw new CallError('x_not_queued', `${sample} is not in the lab; unload it from the rover first`)
      dev.update({ mode: 'analyzing' })
      try {
        for (let i = 1; i <= 12; i++) {
          await wait(call, 500)
          call.progress({ done: i, total: 12, text: `analyzing ${sample}` })
        }
      } finally {
        dev.update({ mode: 'idle' })
      }
      queue.splice(at, 1)
      const finding = FINDINGS[sample as string] ?? {
        minerals: { basalt: 80, other: 20 },
        verdict: 'ordinary basalt, like the rest of the crater floor',
      }
      const minerals = Object.entries(finding.minerals)
        .map(([m, p]) => `${m} ${p} %`)
        .join(', ')
      const sentence = `${sample}: ${finding.verdict} (${minerals})`
      dev.update({ queue: queue.length, last_result: sentence })
      return { detail: sentence, data: { sample, ...finding } }
    },
  )
  world.onReset(() => {
    queue.length = 0
    oven = 22
    base.rotation.y = 0
    shoulder.rotation.z = -0.55
    elbow.rotation.z = 1.25
    world.parts.arm.busy = false
    dev.update({ mode: 'idle', queue: 0, last_result: 'nothing analyzed yet' })
  })
  return dev
}
