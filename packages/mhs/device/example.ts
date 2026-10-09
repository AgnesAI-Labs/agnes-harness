/**
 * A small example device in TypeScript: a desk lamp whose head tilts.
 *
 *   pnpm exec tsx packages/mhs/device/example.ts [ws://127.0.0.1:4180]
 */
import { Device } from './device.js'

const SPEED = 15 // deg/s
let tilt = 0
let speed = 0
let on = false

const lamp = new Device({
  id: 'desk-lamp-01',
  kind: 'light',
  name: 'Desk lamp',
  resources: { head: 'reject' },
  manual: {
    axes: [{ id: 'tilt', role: 'pitch', unit: 'deg/s', min: -SPEED, max: SPEED }],
    rate_hz: 10,
    deadman_s: 0.5,
  },
})
lamp.log = (line) => console.log(line)
lamp.onStop = () => {
  speed = 0
}
lamp.onManual = (axes) => {
  speed = axes.tilt ?? 0
}
const state = lamp.source('state', 'values', 'lamp state', {
  hz: 2,
  default: true,
  fields: { tilt: { type: 'number', unit: 'deg', min: -45, max: 45 }, on: { type: 'boolean' } },
})

lamp.tool(
  {
    name: 'tilt',
    description: 'Tilt the lamp head to an angle in degrees; positive tilts up.',
    timeout: 10,
    params: { angle: { type: 'number', minimum: -45, maximum: 45, description: 'degrees, up positive' } },
    required: ['angle'],
    uses: ['head'],
    motion: true,
    pausable: true,
  },
  async (call, { angle }) => {
    try {
      while (Math.abs(angle - tilt) > 0.5) {
        await call.checkpoint(() => {
          speed = 0
        })
        speed = Math.sign(angle - tilt) * SPEED
        call.progress({ done: Math.round(tilt), total: angle })
        await call.sleep(50)
      }
    } finally {
      speed = 0
    }
    return `head at ${tilt.toFixed(0)} degrees`
  },
)
lamp.tool(
  {
    name: 'switch',
    description: 'Turn the light on or off.',
    timeout: 2,
    params: { on: { type: 'boolean' } },
    required: ['on'],
  },
  (_, args) => {
    on = args.on
    return `light ${on ? 'on' : 'off'}`
  },
)

setInterval(() => {
  tilt = Math.max(-45, Math.min(45, tilt + speed * 0.02))
  if (state.wants()) state.send({ tilt: Math.round(tilt * 10) / 10, on })
}, 20)

await lamp.run(process.argv[2] ?? 'ws://127.0.0.1:4180')
process.exit(0)
