import type { DeviceTool, Field, Registration, Source } from '@agnes/mhs-device'
import { BASE_MAP, DEVICE_IDS, type DeviceId, SPAWNS } from './world.js'

const number = (min: number, max: number, unit?: string): Field => ({
  type: 'number',
  min,
  max,
  ...(unit ? { unit } : {}),
})
const text: Field = { type: 'string' }
const flag: Field = { type: 'boolean' }
const coord = { type: 'number', minimum: -80, maximum: 80 }
const choice = (...values: string[]) => ({ type: 'string', enum: values })
function tool(name: string, properties: Record<string, unknown> = {}, motion = false): DeviceTool {
  return {
    name,
    description: `Simulated ${name.replaceAll('_', ' ')}. Read state and verify the result.`,
    inputSchema: { type: 'object', properties, required: Object.keys(properties) },
    timeout: 120,
    uses: [motion ? 'motion' : 'operation'],
    motion,
    pausable: motion,
  }
}
const at = { x: coord, y: coord }
export const TOOLS: Partial<Record<DeviceId, DeviceTool[]>> = {
  'habitat-01': [tool('set_mode', { mode: choice('normal', 'storm_shelter', 'medical') })],
  'airlock-01': ['cycle_in', 'cycle_out', 'open_outer', 'close_outer'].map((n) => tool(n, {}, true)),
  'rover-01': [
    { ...tool('plan_route', at), readOnly: true, uses: [] },
    tool('drive_to', at, true),
    tool(
      'follow_route',
      {
        points: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: { type: 'array', minItems: 2, maxItems: 2, items: coord },
        },
      },
      true,
    ),
    tool('collect_sample', { target: choice('rock-1') }, true),
    tool('dock', {}, true),
  ],
  'hopper-01': [
    tool('take_off', { alt: { type: 'number', minimum: 1, maximum: 30 } }, true),
    tool('fly_to', { ...at, alt: { type: 'number', minimum: 1, maximum: 30 } }, true),
    tool('survey', { area: choice('west field', 'east dunes') }, true),
    tool('land', { pad: choice('hopper pad', 'landing pad') }, true),
  ],
  'monolith-01': [
    tool('go_to', { ...at, gait: choice('walk', 'roll') }, true),
    tool(
      'follow',
      {
        target: choice('suit-01', 'rover-01', 'hopper-01'),
        seconds: { type: 'number', minimum: 1, maximum: 30 },
      },
      true,
    ),
    tool('carry', { target: choice('suit-01', 'rock-1') }, true),
    tool('put_down', {}, true),
    tool('say', { text: { type: 'string', maxLength: 1000 } }),
  ],
  'lab-01': [tool('unload_rover', {}, true), tool('analyze', { sample: choice('rock-1') })],
  'power-01': [
    tool('stow_array', {}, true),
    tool('deploy_array', {}, true),
    tool('clean_array', {}, true),
    tool('shed', { load: choice('lab', 'comms'), on: { type: 'boolean' } }),
  ],
  'comms-01': [
    tool('point', { target: choice('earth', 'orbiter') }, true),
    tool('send', { report: { type: 'string', maxLength: 4096 } }),
  ],
  'cam-base': [
    tool('look_at', { preset: choice('overview', 'field', 'dock', 'pad') }, true),
    tool('zoom', { level: { type: 'number', minimum: 1, maximum: 4 } }, true),
  ],
}
export const INITIAL: Record<DeviceId, Record<string, string | number | boolean>> = {
  'habitat-01': { mode: 'normal', o2: 21, co2: 450, pressure: 101, temperature: 21 },
  'airlock-01': { mode: 'pressurized', pressure: 101, inner: 'closed', outer: 'closed', occupied: false },
  'suit-01': { o2_left: 18, battery: 60, comm: true, rescued: false, heart_rate: 110, temperature: 22 },
  'rover-01': { mode: 'idle', battery: 100, cargo: 'none', docked: true },
  'hopper-01': { mode: 'landed', propellant: 100, battery: 100, flight_time_left: 180, max_altitude: 30 },
  'monolith-01': { gait: 'walk', mode: 'idle', battery: 100, carrying: 'none', humor: 75, honesty: 90 },
  'lab-01': { mode: 'idle', queue: 'none', last_result: 'none' },
  'power-01': {
    storage: 90,
    production: 8,
    load: 5,
    dust: 10,
    panels: 'deployed',
    shed: 'none',
    priority: 'life_support',
  },
  'weather-01': { storm_warning: 'watch', wind: 12, dust: 0.3, temperature: -45 },
  'comms-01': { link: false, target: 'none', window: true, last_report: 'none' },
  'cam-base': { preset: 'overview', zoom: 1 },
}
export const CAMERA_SOURCES: Partial<Record<DeviceId, string[]>> = {
  'cam-base': ['view'],
  'suit-01': ['helmet'],
  'rover-01': ['front', 'hazcam'],
  'hopper-01': ['down', 'front'],
  'monolith-01': ['front'],
  'lab-01': ['arm'],
}
export function registration(id: DeviceId, video: boolean): Registration {
  const state: Record<string, Field> = {}
  for (const [key, value] of Object.entries(INITIAL[id]))
    state[key] = typeof value === 'number' ? number(-100, 10000) : typeof value === 'boolean' ? flag : text
  for (const key of ['battery', 'propellant', 'storage', 'o2_left'])
    if (key in state)
      state[key] = {
        ...number(0, 100, '%'),
        role: key === 'o2_left' ? 'consumable' : 'battery',
        alert: { warn: 25, bad: 10, below: true },
      }
  for (const key of ['humor', 'honesty']) if (key in state) state[key] = { ...number(0, 100), writable: true }
  if (id === 'power-01')
    state.priority = { type: 'string', enum: ['life_support', 'science'], writable: true }
  const sources: Source[] = [
    {
      id: 'pose',
      kind: 'pose',
      description: 'Metres east/north of habitat; yaw counterclockwise from east.',
      hz: 2,
    },
    { id: 'readings', kind: 'values', description: 'Synthetic device readings', hz: 1, fields: state },
  ]
  for (const camera of CAMERA_SOURCES[id] ?? []) {
    sources.push({
      id: camera,
      kind: 'image',
      description: `Simulated ${camera} camera`,
      mime: 'image/png',
      hz: 1,
      sizes: [[640, 360]],
    })
    if (video)
      sources.push({
        id: `${camera}_video`,
        kind: 'video',
        description: 'Simulated camera video',
        codec: 'h264',
        gop_s: 1,
        hz: 20,
        default: false,
        switchable: true,
        sizes: [[640, 360]],
        bitrate_kbps: [600, 1200],
      })
  }
  if (id === 'rover-01')
    sources.push(
      { id: 'lidar', kind: 'scan', description: 'Obstacle ranges in rover frame', hz: 2, range_m: [0, 40] },
      { id: 'occupancy', kind: 'grid', description: 'North-up base occupancy', hz: 1 },
    )
  const mobile = ['rover-01', 'hopper-01', 'monolith-01', 'suit-01'].includes(id)
  return {
    protocol: 'mhs/v1',
    device: { id, kind: id.split('-')[0]!, name: `${id} (simulation)`, mobile, vendor: 'Agnes example' },
    state,
    sources,
    tools: TOOLS[id] ?? [],
    resources: { motion: 'reject', operation: 'reject' },
    localization: mobile ? 'self' : 'fixed',
    placement: { map: BASE_MAP.id, ...SPAWNS[id], yaw: 0 },
    ...(id === 'habitat-01' ? { maps: [BASE_MAP] } : {}),
    ...(['rover-01', 'monolith-01'].includes(id)
      ? {
          manual: {
            axes: [
              { id: 'vx', min: -2, max: 2, role: 'forward' },
              { id: 'wz', min: -1, max: 1, role: 'turn' },
            ],
            rate_hz: 30,
            deadman_s: 0.3,
          },
        }
      : {}),
  }
}
export const DESCRIPTIONS = DEVICE_IDS.map((id) => registration(id, false))
