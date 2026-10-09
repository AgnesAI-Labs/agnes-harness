import { LAYOUT } from '../base.js'
import { placed } from './basemap.js'
import { every, turnTo, type World, WorldDevice, wait } from './world.js'

/** Where the dish points for each target: head rotation in radians. */
const AIM = { earth: { x: -0.7, y: 2.4 }, orbiter: { x: -1.25, y: -0.6 } } as const
/** Earth is in view for 180 s of every 240 s, starting 120 s after the page opens. */
const PERIOD = 240
const OPEN = 180
const FIRST_OPEN = 120

/** The comms dish: points at Earth or an orbiter, and sends reports while Earth is in view. */
export function comms(world: World, log: (line: string) => void): WorldDevice {
  let started = Date.now() / 1000
  let target: 'earth' | 'orbiter' | 'none' = 'none'
  const windowNow = () => {
    const now = Date.now() / 1000
    const since = now - started
    if (since < FIRST_OPEN) return { open: false, changes: Math.round(started + FIRST_OPEN) }
    const k = (since - FIRST_OPEN) % PERIOD
    const cycle = now - k
    return k < OPEN
      ? { open: true, changes: Math.round(cycle + OPEN) }
      : { open: false, changes: Math.round(cycle + PERIOD) }
  }
  const linkUp = () => target === 'earth' && windowNow().open
  const dev = new WorldDevice({
    id: 'comms-01',
    kind: 'antenna',
    name: 'Comms dish',
    model: 'Agnes Base high-gain dish',
    localization: 'fixed',
    // At rest the dish faces north.
    placement: placed(LAYOUT.comms, 90),
    resources: { dish: 'reject' },
    state: {
      link: { type: 'string', enum: ['up', 'down'], description: 'a working link to Earth' },
      target: { type: 'string', enum: ['earth', 'orbiter', 'none'], description: 'where the dish points' },
      window: { type: 'string', enum: ['open', 'closed'], description: 'whether Earth is above the horizon' },
      window_changes_at: {
        type: 'number',
        unit: 's',
        description: 'Unix time when the window next opens or closes',
      },
    },
  })
  dev.log = log
  const report = () => {
    const w = windowNow()
    dev.update({
      link: linkUp() ? 'up' : 'down',
      target,
      window: w.open ? 'open' : 'closed',
      window_changes_at: w.changes,
    })
  }
  report()
  every(1000, report, log)
  const signal = dev.source('signal', 'values', 'signal strength of the link to Earth, and the transmitter', {
    hz: 1,
    fields: {
      temperature: {
        type: 'number',
        unit: '°C',
        min: -40,
        max: 90,
        role: 'temperature',
        of: 'transmitter',
        alert: { warn: 60, bad: 75 },
      },
      strength: {
        type: 'number',
        unit: 'dBm',
        min: -150,
        max: -60,
        role: 'signal',
        of: 'earth',
        alert: { warn: -110, bad: -130, below: true },
      },
    },
  })
  every(
    1000,
    () => {
      if (!signal.wants()) return
      signal.send({
        strength: linkUp() ? Math.round((-96 + Math.random() * 3) * 10) / 10 : -140,
        temperature: Math.round((linkUp() ? 38 : 12) + Math.random() * 10) / 10,
      })
    },
    log,
  )
  dev.unsafe = (tool) => {
    if (tool !== 'send' || linkUp()) return undefined
    if (target !== 'earth') return 'the dish is not pointed at Earth'
    return `Earth is below the horizon; the window opens in ${Math.round(windowNow().changes - Date.now() / 1000)} s`
  }

  dev.tool(
    {
      name: 'point',
      description: 'Point the dish at Earth or at the relay orbiter.',
      timeout: 15,
      params: { target: { type: 'string', enum: ['earth', 'orbiter'] } },
      required: ['target'],
      uses: ['dish'],
      motion: true,
    },
    async (call, { target: to }) => {
      const aim = AIM[to as 'earth' | 'orbiter']
      target = 'none'
      report()
      await turnTo(call, world.parts.dishHead, aim, 2500)
      target = to as 'earth' | 'orbiter'
      report()
      return to === 'earth' && !windowNow().open
        ? 'pointed at Earth, which is below the horizon for now'
        : `pointed at ${to === 'earth' ? 'Earth; link up' : 'the orbiter'}`
    },
  )
  dev.tool(
    {
      name: 'send',
      description: 'Send a report to Earth. Needs the dish pointed at Earth while the window is open.',
      timeout: 30,
      params: { report: { type: 'string', maxLength: 4000 } },
      required: ['report'],
      uses: ['dish'],
    },
    async (call, { report: text }) => {
      const steps = Math.max(3, Math.ceil((text as string).length / 400))
      for (let i = 1; i <= steps; i++) {
        await wait(call, 600)
        call.progress({ done: i, total: steps, text: 'sending' })
      }
      return {
        detail: `sent ${(text as string).length} characters to Earth`,
        data: { characters: (text as string).length },
      }
    },
  )
  world.onReset(() => {
    started = Date.now() / 1000
    target = 'none'
    world.parts.dishHead.rotation.set(-0.95, 0.75, 0)
    report()
  })
  return dev
}
