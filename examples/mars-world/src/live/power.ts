import { type Call, CallError } from '@agnes/mhs/device'
import { LAYOUT, PANEL_TILT } from '../base.js'
import { placed } from './basemap.js'
import { reading } from './place.js'
import { every, type World, WorldDevice, wait } from './world.js'

/** Battery bank capacity in watt-hours, and solar output in watts at noon with clean panels. */
const CAPACITY_WH = 60000
const PEAK_W = 9000
/** Loads the base can shed, in watts. */
const LOADS = { science: 900, greenhouse: 1400, charging: 1500 } as const
const LIFE_SUPPORT_W = 2600
/** Seconds to stow or deploy the array. */
const TILT_S = 5
type Load = keyof typeof LOADS

/** The power system: solar array, battery bank and the loads it feeds. */
export function power(world: World, log: (line: string) => void): WorldDevice {
  let storage = 74
  let dust = 12
  let tilt: number = PANEL_TILT.deployed
  let panels: 'deployed' | 'stowed' | 'moving' = 'deployed'
  const shed = new Set<Load>()
  let priority: 'life_support' | 'charging' | 'science' = 'life_support'
  const dev = new WorldDevice({
    id: 'power-01',
    kind: 'power',
    name: 'Power',
    model: 'Agnes Base solar array and battery bank',
    localization: 'fixed',
    // At the battery bank; the array east of it faces south.
    placement: placed(LAYOUT.battery, 270),
    profile: {
      notes: `A ${PEAK_W / 1000} kW solar array and a ${CAPACITY_WH / 1000} kWh battery bank. Life support always gets power first; priority decides who gets the rest.`,
    },
    resources: { array: 'reject', loads: 'queue' },
    state: {
      storage: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        role: 'battery',
        of: 'bank',
        alert: { warn: 30, bad: 15, below: true },
        description: 'charge of the battery bank',
      },
      production: {
        type: 'integer',
        unit: 'W',
        min: 0,
        max: PEAK_W,
        description: 'what the solar array delivers now',
      },
      load: {
        type: 'integer',
        unit: 'W',
        min: 0,
        max: 12000,
        role: 'power',
        of: 'base',
        description: 'what the base draws',
      },
      dust: {
        type: 'integer',
        unit: '%',
        min: 0,
        max: 100,
        alert: { warn: 30, bad: 60 },
        description: 'how much light the dust on the panels blocks',
      },
      panels: { type: 'string', enum: ['deployed', 'stowed', 'moving'] },
      shed: { type: 'string', description: 'loads switched off, comma-separated, or none' },
      priority: {
        type: 'string',
        enum: ['life_support', 'charging', 'science'],
        writable: true,
        description: 'who gets power first after life support',
      },
    },
  })
  dev.log = log
  const load = () =>
    LIFE_SUPPORT_W +
    (Object.entries(LOADS) as [Load, number][])
      .filter(([k]) => !shed.has(k) && (k !== 'charging' || world.rover.docked))
      .reduce((n, [, w]) => n + w, 0)
  /** Solar output: the sun with a slow haze drift, dust, and how far the panels face the sun. */
  const production = () => {
    const day = 0.85 + 0.1 * Math.sin(performance.now() / 300000)
    const facing = Math.cos(((tilt - PANEL_TILT.deployed) * Math.PI) / 180)
    return PEAK_W * day * (1 - dust / 100) * Math.max(0.08, facing ** 4)
  }
  const report = () =>
    dev.update({
      storage: Math.round(storage),
      production: Math.round(production() / 10) * 10,
      load: load(),
      dust: Math.round(dust),
      panels,
      shed: shed.size ? [...shed].join(', ') : 'none',
      priority,
    })
  report()
  dev.onSet = (name, value) => {
    if (name === 'priority') priority = value as typeof priority
    report()
    return priority
  }
  const flow = dev.source('flow', 'values', 'power produced, drawn and stored', {
    hz: 1,
    default: true,
    fields: {
      production: { type: 'number', unit: 'W', min: 0, max: PEAK_W },
      load: { type: 'number', unit: 'W', min: 0, max: 12000, role: 'power', of: 'base' },
      voltage: { type: 'number', unit: 'V', min: 100, max: 130, role: 'voltage', of: 'bank' },
      bank_temperature: {
        type: 'number',
        unit: '°C',
        min: -20,
        max: 60,
        role: 'temperature',
        of: 'battery',
        alert: { warn: 40, bad: 50 },
      },
    },
  })
  every(
    1000,
    () => {
      const net = production() - load()
      // The bank's clock runs 30 times faster than the scene's, so a change shows within a demo.
      storage = Math.max(0, Math.min(100, storage + (net / CAPACITY_WH) * (100 / 3600) * 30))
      dust = Math.min(100, dust + 0.01)
      if (!flow.wants()) return
      flow.send({
        production: Math.round(production()),
        load: Math.round(load() + (Math.random() - 0.5) * 60),
        voltage: reading(110 + storage * 0.15, 0.1),
        bank_temperature: reading(18 + Math.abs(net) / 1000, 0.2),
      })
    },
    log,
  )
  every(5000, report, log)

  const turn = async (call: Call, to: number, end: 'deployed' | 'stowed') => {
    panels = 'moving'
    report()
    const from = tilt
    try {
      const steps = TILT_S * 10
      for (let i = 1; i <= steps; i++) {
        await wait(call, 100)
        const k = i / steps
        tilt = from + (to - from) * k * k * (3 - 2 * k)
        world.parts.tiltPanels(tilt)
        if (i % 10 === 0)
          call.progress({
            done: i / 10,
            total: TILT_S,
            text: `${end === 'stowed' ? 'stowing' : 'deploying'} the array`,
          })
      }
      panels = end
    } finally {
      if (panels === 'moving')
        panels = tilt > (PANEL_TILT.deployed + PANEL_TILT.stowed) / 2 ? 'stowed' : 'deployed'
      report()
    }
  }

  dev.unsafe = (tool) => {
    if (tool === 'clean_array' && panels !== 'deployed') return 'the array is not deployed'
    return undefined
  }

  dev.tool(
    {
      name: 'stow_array',
      description: 'Turn the solar panels on edge, out of a dust storm. Production drops to almost nothing.',
      timeout: TILT_S + 10,
      uses: ['array'],
      motion: true,
      ui: { label: 'Stow array' },
    },
    async (call) => {
      await turn(call, PANEL_TILT.stowed, 'stowed')
      return `array stowed; producing ${Math.round(production())} W`
    },
  )
  dev.tool(
    {
      name: 'deploy_array',
      description: 'Turn the solar panels back toward the sun.',
      timeout: TILT_S + 10,
      uses: ['array'],
      motion: true,
      ui: { label: 'Deploy array' },
    },
    async (call) => {
      await turn(call, PANEL_TILT.deployed, 'deployed')
      return `array deployed; producing ${Math.round(production())} W`
    },
  )
  dev.tool(
    {
      name: 'clean_array',
      description: 'Shake the dust off the deployed panels.',
      timeout: 20,
      uses: ['array'],
      motion: true,
      ui: { label: 'Clean array' },
    },
    async (call) => {
      const from = dust
      for (let i = 1; i <= 10; i++) {
        await wait(call, 500)
        dust = from * (1 - i / 10) + 2 * (i / 10)
        call.progress({ done: i, total: 10, text: `cleaning: ${Math.round(dust)} % dust` })
      }
      report()
      return `panels cleaned; dust ${Math.round(dust)} %, producing ${Math.round(production())} W`
    },
  )
  dev.tool(
    {
      name: 'shed',
      description: 'Switch a load off to save power, or back on. Life support cannot be shed.',
      timeout: 10,
      params: {
        load: { type: 'string', enum: Object.keys(LOADS), description: 'which load' },
        on: { type: 'boolean', default: false, description: 'true switches the load back on' },
      },
      required: ['load'],
      uses: ['loads'],
      ui: { label: 'Shed load' },
    },
    async (call, { load: which, on }) => {
      if (!(which in LOADS)) throw new CallError('x_no_such_load', `there is no load ${which}`)
      await wait(call, 500)
      if (on) shed.delete(which as Load)
      else shed.add(which as Load)
      report()
      return `${which} ${on ? 'back on' : 'switched off'}; the base draws ${load()} W`
    },
  )
  world.onReset(() => {
    storage = 74
    dust = 12
    tilt = PANEL_TILT.deployed
    world.parts.tiltPanels(tilt)
    panels = 'deployed'
    shed.clear()
    priority = 'life_support'
    report()
  })
  return dev
}
