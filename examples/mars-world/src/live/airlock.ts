import type { Call } from '@agnes/mhs/device'
import { LAYOUT } from '../base.js'
import { placed } from './basemap.js'
import { reading } from './place.js'
import { every, turnTo, type World, WorldDevice, wait } from './world.js'

/** Chamber pressure in kPa: the habitat's, and Mars outside. */
const INSIDE = 101.3
const OUTSIDE = 0.7
/** Seconds to pump the chamber down or up. */
export const CYCLE_S = 10
/** Seconds the outer door takes to swing open or shut. */
const DOOR_S = 2
const OPEN = 1.9

/** Inside the habitat, where the astronaut goes once the inner door opens for them. */
const HABITAT = { x: 0, z: 5 }

/**
 * The airlock: pumps its chamber between habitat pressure and Mars, and opens its outer door. Someone
 * set into the chamber (Monolith brings the astronaut) steps into the habitat once cycle_in opens the
 * inner door.
 */
export function airlock(world: World, log: (line: string) => void): WorldDevice {
  const { door, astronaut } = world.parts
  let pressure = INSIDE
  let inner: 'open' | 'closed' = 'open'
  const dev = new WorldDevice({
    id: 'airlock-01',
    kind: 'door',
    name: 'Airlock',
    model: 'Agnes Base airlock',
    localization: 'fixed',
    // At the outer door, facing out of it, south.
    placement: placed(LAYOUT.airlockDoor, 270),
    profile: {
      notes:
        'One person at a time. The outer door opens only at Mars pressure, the inner door only at habitat pressure; a full cycle takes about ten seconds.',
    },
    resources: { chamber: 'reject' },
    state: {
      mode: { type: 'string', enum: ['idle', 'depressurizing', 'pressurizing'] },
      pressure: {
        type: 'number',
        unit: 'kPa',
        min: 0,
        max: 105,
        description: 'chamber pressure, rounded to whole kPa',
      },
      inner: { type: 'string', enum: ['open', 'closed'], description: 'the door to the habitat' },
      outer: { type: 'string', enum: ['open', 'closed'], description: 'the door to the outside' },
      occupied: { type: 'boolean', description: 'someone is in the chamber' },
    },
  })
  dev.log = log
  const report = () =>
    dev.update({
      pressure: Math.round(pressure),
      inner,
      outer: world.airlock.outer,
      occupied: world.astronaut === 'chamber',
    })
  world.airlockChanged = report
  dev.update({ mode: 'idle' })
  report()
  const chamber = dev.source('chamber', 'values', 'pressure and temperature in the chamber', {
    hz: 2,
    default: true,
    fields: {
      pressure: { type: 'number', unit: 'kPa', min: 0, max: 105 },
      temperature: { type: 'number', unit: '°C', min: -60, max: 30, role: 'temperature', of: 'chamber' },
    },
  })
  every(
    500,
    () => {
      if (!chamber.wants()) return
      // The chamber cools as it empties, and warms again once pressurized.
      const temperature = -50 + (70 * pressure) / INSIDE
      chamber.send({ pressure: reading(pressure, 0.02, 2), temperature: reading(temperature, 0.2) })
    },
    log,
  )

  /** Pumps toward `target` kPa, reporting progress; interruptible at every step. */
  const pump = async (call: Call, target: number, mode: 'depressurizing' | 'pressurizing') => {
    dev.update({ mode })
    const from = pressure
    const steps = CYCLE_S * 4
    try {
      for (let i = 1; i <= steps; i++) {
        await wait(call, 250)
        // Pressure falls (or rises) exponentially, like a pump on a fixed volume.
        const k = (1 - Math.exp((-5 * i) / steps)) / (1 - Math.exp(-5))
        pressure = from + (target - from) * k
        if (i % 4 === 0) {
          report()
          call.progress({ done: i / 4, total: CYCLE_S, text: `${mode}: ${pressure.toFixed(1)} kPa` })
        }
      }
    } finally {
      dev.update({ mode: 'idle' })
      report()
    }
  }
  const swing = async (call: Call, to: 'open' | 'closed') => {
    await turnTo(call, door, { y: to === 'open' ? OPEN : 0 }, DOOR_S * 1000)
    world.airlock.outer = to
    report()
  }

  dev.unsafe = (tool) => {
    if (tool === 'open_outer' && pressure > 1) return `chamber at ${pressure.toFixed(1)} kPa; cycle_out first`
    if (tool === 'cycle_in' && world.airlock.outer === 'open')
      return 'the outer door is open; close_outer first'
    return undefined
  }

  dev.tool(
    {
      name: 'cycle_out',
      description:
        'Close the inner door and pump the chamber down to Mars pressure, so the outer door can open.',
      timeout: CYCLE_S + 10,
      uses: ['chamber'],
      motion: true,
      ui: { label: 'Cycle out' },
    },
    async (call) => {
      inner = 'closed'
      report()
      await pump(call, OUTSIDE, 'depressurizing')
      return `chamber at ${pressure.toFixed(1)} kPa; the outer door may open`
    },
  )
  dev.tool(
    {
      name: 'cycle_in',
      description:
        'With the outer door shut, pressurize the chamber to habitat pressure and open the inner door.',
      timeout: CYCLE_S + 10,
      uses: ['chamber'],
      motion: true,
      ui: { label: 'Cycle in' },
    },
    async (call) => {
      await pump(call, INSIDE, 'pressurizing')
      inner = 'open'
      const person = world.astronaut === 'chamber'
      if (person) {
        world.astronaut = 'inside'
        astronaut.visible = false
        astronaut.position.set(HABITAT.x, world.ground(HABITAT), HABITAT.z)
      }
      report()
      return {
        detail: `chamber at ${pressure.toFixed(1)} kPa; the inner door is open${person ? '; the astronaut (suit-01) stepped into the habitat' : ''}`,
        data: { pressure: Math.round(pressure), ...(person ? { came_in: 'suit-01' } : {}) },
      }
    },
  )
  dev.tool(
    {
      name: 'open_outer',
      description: 'Open the outer door. Needs the chamber at Mars pressure (cycle_out).',
      timeout: DOOR_S + 10,
      uses: ['chamber'],
      motion: true,
      ui: { label: 'Open outer door' },
    },
    async (call) => {
      await swing(call, 'open')
      return 'the outer door is open'
    },
  )
  dev.tool(
    {
      name: 'close_outer',
      description: 'Close the outer door.',
      timeout: DOOR_S + 10,
      uses: ['chamber'],
      motion: true,
      ui: { label: 'Close outer door' },
    },
    async (call) => {
      await swing(call, 'closed')
      return 'the outer door is closed'
    },
  )
  world.onReset(() => {
    pressure = INSIDE
    inner = 'open'
    door.rotation.y = 0
    dev.update({ mode: 'idle' })
    report()
  })
  return dev
}
