import { Color } from 'three'
import { LAYOUT } from '../base.js'
import { BASE_MAP, placed } from './basemap.js'
import { reading } from './place.js'
import { every, type World, WorldDevice, wait } from './world.js'

const MODES = {
  normal: { color: 0xffc387, glow: 1.45, sentence: 'normal operations' },
  storm_shelter: {
    color: 0xff8a3a,
    glow: 0.9,
    sentence: 'storm shelter: crew inside, non-essential loads off',
  },
  medical: { color: 0xdff4ff, glow: 2.4, sentence: 'medical: the bay is lit and warmed, oxygen raised' },
} as const
type Mode = keyof typeof MODES

/** The habitat: its air, and a mode for storms and emergencies that its windows show. */
export function habitat(world: World, log: (line: string) => void): WorldDevice {
  let mode: Mode = 'normal'
  const air = { o2: 20.9, co2: 900, pressure: 101.3, temperature: 21.5, humidity: 38 }
  const dev = new WorldDevice({
    id: 'habitat-01',
    kind: 'habitat',
    name: 'Habitat',
    model: 'Agnes Base habitat dome',
    localization: 'fixed',
    // Facing its airlock, south. The habitat is the origin of the base map, which it declares.
    placement: placed(LAYOUT.habitat, 270),
    maps: [BASE_MAP],
    resources: { systems: 'queue' },
    state: {
      mode: { type: 'string', enum: Object.keys(MODES), description: 'what the habitat is set up for' },
      o2: {
        type: 'number',
        unit: '%',
        min: 15,
        max: 25,
        role: 'consumable',
        of: 'oxygen',
        alert: { warn: 19.5, bad: 18, below: true },
        description: 'oxygen in the cabin air',
      },
      co2: { type: 'integer', unit: 'ppm', min: 0, max: 6000, alert: { warn: 2500, bad: 5000 } },
      pressure: {
        type: 'number',
        unit: 'kPa',
        min: 80,
        max: 105,
        alert: { warn: 95, bad: 90, below: true },
        description: 'cabin pressure',
      },
      temperature: {
        type: 'number',
        unit: '°C',
        min: 10,
        max: 35,
        role: 'temperature',
        of: 'air',
        alert: { warn: 27, bad: 30 },
      },
    },
  })
  dev.log = log
  const report = () =>
    dev.update({
      mode,
      o2: Math.round(air.o2 * 10) / 10,
      co2: Math.round(air.co2 / 10) * 10,
      pressure: Math.round(air.pressure * 10) / 10,
      temperature: Math.round(air.temperature * 10) / 10,
    })
  report()
  const curves = dev.source('air', 'values', 'cabin air quality', {
    hz: 1,
    default: true,
    fields: {
      o2: { type: 'number', unit: '%', min: 15, max: 25, alert: { warn: 19.5, bad: 18, below: true } },
      co2: { type: 'integer', unit: 'ppm', min: 0, max: 6000, alert: { warn: 2500, bad: 5000 } },
      pressure: { type: 'number', unit: 'kPa', min: 80, max: 105, alert: { warn: 95, bad: 90, below: true } },
      temperature: { type: 'number', unit: '°C', min: 10, max: 35, role: 'temperature', of: 'air' },
      humidity: { type: 'number', unit: '%', min: 0, max: 100 },
    },
  })
  every(
    1000,
    () => {
      // The air drifts toward what the mode sets: more oxygen and warmth in medical mode.
      const want = mode === 'medical' ? { o2: 23, temperature: 23.5 } : { o2: 20.9, temperature: 21.5 }
      air.o2 += (want.o2 - air.o2) * 0.02
      air.temperature += (want.temperature - air.temperature) * 0.02
      air.co2 = 900 + Math.sin(performance.now() / 60000) * 120
      if (curves.wants())
        curves.send({
          o2: reading(air.o2, 0.03, 2),
          co2: Math.round(air.co2 + Math.random() * 20),
          pressure: reading(air.pressure, 0.05, 2),
          temperature: reading(air.temperature, 0.05, 2),
          humidity: reading(air.humidity, 0.3),
        })
    },
    log,
  )
  every(5000, report, log)

  dev.tool(
    {
      name: 'set_mode',
      description:
        'Set the habitat up for normal operations, as a storm shelter (crew inside, non-essential loads off), or for medical care (bay lit and warmed, oxygen raised).',
      timeout: 15,
      params: {
        mode: { type: 'string', enum: Object.keys(MODES), description: 'what to set the habitat up for' },
      },
      required: ['mode'],
      uses: ['systems'],
      ui: { label: 'Set mode' },
    },
    async (call, { mode: next }) => {
      const to = MODES[next as Mode]
      const windows = world.parts.windows
      const from = { color: windows.emissive.clone(), glow: windows.emissiveIntensity }
      const target = new Color(to.color)
      for (let i = 1; i <= 10; i++) {
        await wait(call, 150)
        windows.emissive.lerpColors(from.color, target, i / 10)
        windows.emissiveIntensity = from.glow + (to.glow - from.glow) * (i / 10)
        call.progress({ done: i, total: 10, text: `switching to ${next}` })
      }
      mode = next as Mode
      report()
      return `habitat set to ${to.sentence}`
    },
  )
  world.onReset(() => {
    mode = 'normal'
    Object.assign(air, { o2: 20.9, co2: 900, pressure: 101.3, temperature: 21.5, humidity: 38 })
    world.parts.windows.emissive.set(MODES.normal.color)
    world.parts.windows.emissiveIntensity = MODES.normal.glow
    report()
  })
  return dev
}
