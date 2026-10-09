/**
 * A development AgnesHub, for working on the Devices panel and the brain without hardware: the real
 * AgnesHub with four sample devices built on the device library, and the panel as a page of its own
 * at `/`.
 *
 *   pnpm --filter @agnes/mhs build:plugin && pnpm --filter @agnes/mhs dev-hub [port]
 *
 * Then open http://127.0.0.1:4191/ (add ?lang=zh-CN, ?theme=light, ?device=robot-01).
 *   robot-01  a mobile robot: camera, pose and map (it declares the office with its rooms), scan,
 *             odometry, manual drive, tools with progress
 *   lamp-01   writable state only: on, brightness, colour
 *   env-01    sensors only, installed in the office: a values source with alert levels (CO2 climbs
 *             past them), a door switch
 *   arm-01    an arm without camera: joint axes, a microphone that can be switched off, a log
 * DEV_DEVICES_TO=ws://127.0.0.1:4180 connects the same devices to a running AgnesHub instead, and
 * DEV_DEVICES=robot-01 only the listed ones, for example to run mhs-check against one device.
 * Type `health robot-01 hot` or `pose robot-01 lost` on stdin to push health and position around.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'
import { Device } from '../device/device.js'
import { North } from '../server/north.js'
import { South } from '../server/south.js'

const port = Number(process.argv[2] ?? 4191)
const root = new URL('../plugin/client/', import.meta.url)

// --- a tiny PNG encoder, so pictures need no dependency ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = (buf: Buffer) => {
  let c = 0xffffffff
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc(body))
  return Buffer.concat([len, body, sum])
}
/** `channels` 1 (gray) or 3 (RGB); `pixel(x, y)` returns that many bytes. */
function png(w: number, h: number, channels: 1 | 3, pixel: (x: number, y: number) => number[]): Uint8Array {
  const raw = Buffer.alloc((w * channels + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * channels + 1)
    for (let x = 0; x < w; x++) {
      const p = pixel(x, y)
      for (let c = 0; c < channels; c++) raw[row + 1 + x * channels + c] = p[c] as number
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 1 ? 0 : 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const south = new South({ name: 'dev-hub', log: (line) => console.log(`· ${line}`) })
const north = new North(south, { name: 'dev-hub' })
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0] as string
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Devices</title><link rel="stylesheet" href="/dist/page.css"><div id="app"></div><script type="module" src="/dist/page.js"></script>',
    )
    return
  }
  const types: Record<string, string> = { js: 'text/javascript', css: 'text/css' }
  const type = /^\/dist\/page\.(js|css)$/.test(path) && types[path.split('.').pop() ?? '']
  if (type) {
    res.writeHead(200, { 'content-type': type })
    res.end(readFileSync(new URL(`.${path}`, root)))
    return
  }
  res.writeHead(404).end()
})
server.on('upgrade', (req, socket, head) => {
  if (!south.handleUpgrade(req, socket, head) && !north.handleUpgrade(req, socket, head)) socket.destroy()
})
// DEV_DEVICES_TO=ws://host:port connects the sample devices to a running AgnesHub instead.
const elsewhere = process.env.DEV_DEVICES_TO
if (!elsewhere) await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
const url = elsewhere ?? `ws://127.0.0.1:${port}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- robot-01 ---
const robot = new Device({
  id: 'robot-01',
  kind: 'robot',
  name: 'Robot',
  model: 'Example Mecanum',
  mobile: true,
  localization: 'self',
  maps: [
    {
      id: 'office',
      name: 'Office',
      bounds: [0, 0, 8, 6],
      places: [
        { id: 'dock', name: 'Charging dock', at: [1, 1], yaw: 180 },
        { id: 'desk', name: 'Desk', at: [6, 2], description: 'The desk with the lamp' },
        {
          id: 'west-room',
          name: 'West room',
          points: [
            [0.3, 0.3],
            [3.8, 0.3],
            [3.8, 3.5],
            [0.3, 3.5],
          ],
        },
        {
          id: 'east-room',
          name: 'East room',
          points: [
            [4.1, 0.3],
            [7.7, 0.3],
            [7.7, 3.5],
            [4.1, 3.5],
          ],
        },
        {
          id: 'hall',
          name: 'Hall',
          points: [
            [0.3, 3.5],
            [7.7, 3.5],
            [7.7, 5.7],
            [0.3, 5.7],
          ],
        },
      ],
    },
  ],
  profile: { size_m: [0.5, 0.4, 0.3] },
  resources: { chassis: 'reject', speaker: 'queue' },
  manual: {
    axes: [
      { id: 'vx', role: 'forward', unit: 'm/s', min: -0.5, max: 0.8 },
      { id: 'wz', role: 'turn', unit: 'deg/s', min: -90, max: 90 },
      { id: 'vy', role: 'strafe', unit: 'm/s', min: -0.4, max: 0.4 },
    ],
    rate_hz: 10,
    deadman_s: 0.5,
    speeds: [
      { label: 'slow', scale: 0.4 },
      { label: 'fast', scale: 1 },
    ],
  },
  state: {
    mode: { type: 'string', enum: ['idle', 'driving', 'docked', 'manual'] },
    battery: {
      type: 'integer',
      unit: '%',
      min: 0,
      max: 100,
      role: 'battery',
      alert: { warn: 20, bad: 10, below: true },
    },
    motor_temp: {
      type: 'number',
      unit: '°C',
      role: 'temperature',
      of: 'motor',
      alert: { warn: 70, bad: 85 },
    },
    volume: { type: 'integer', min: 0, max: 10, writable: true, description: 'Speaker volume' },
    lights: { type: 'boolean', writable: true },
  },
  ui: { primary: 'front' },
})
let pose = { x: 1, y: 1, yaw: 30, ok: true }
let odo = { x: 0, y: 0, yaw: 0, v: 0, w: 0 }
let manual = { vx: 0, wz: 0, vy: 0 }
let battery = 86
robot.update({ mode: 'idle', battery, motor_temp: 41, volume: 4, lights: false })
const front = robot.source('front', 'image', 'front camera', {
  hz: 10,
  mime: 'image/png',
  size: [160, 90],
  fov_deg: [90, 55],
  mount: { xyz: [0.2, 0, 0.25], rpy: [0, 0, 0] },
})
const poseSrc = robot.source('pose', 'pose', 'position on the office map', {
  hz: 5,
  model: { name: 'sim-slam', version: '1' },
  max_error_m: 0.5,
})
const grid = robot.source('map', 'grid', 'office occupancy map', {
  hz: 0.2,
  model: { name: 'sim-slam', version: '1' },
})
const scan = robot.source('lidar', 'scan', '2D lidar', {
  hz: 5,
  range_m: [0.1, 6],
  mount: { xyz: [0.15, 0, 0.2], rpy: [0, 0, 0] },
})
const odoSrc = robot.source('odometry', 'odometry', 'wheel odometry since start-up', { hz: 5 })
const walls = (x: number, y: number) =>
  x < 0.3 || y < 0.3 || x > 7.7 || y > 5.7 || (x > 3.8 && x < 4.1 && y < 3.5)
const gridPng = png(160, 120, 1, (px, py) => {
  const x = px * 0.05
  const y = (119 - py) * 0.05
  return [walls(x, y) ? 0 : 255]
})
let frame = 0
setInterval(() => {
  frame += 1
  if (front.wants())
    front.send(
      { w: 160, h: 90 },
      png(160, 90, 3, (x, y) => {
        const band = (x + frame * 3) % 160 < 12
        return band ? [80, 200, 160] : [30 + y, 40 + ((x + frame) % 60), 70 + (y >> 1)]
      }),
    )
}, 100)
const start = { ...pose }
let prev = { ...pose }
const round = (n: number) => Math.round(n * 1000) / 1000
setInterval(() => {
  const dt = 0.2
  const v = manual.vx
  const w = manual.wz
  if (v || w || manual.vy) {
    pose = { ...pose, yaw: (pose.yaw + w * dt + 360) % 360 }
    const a = (pose.yaw * Math.PI) / 180
    pose.x += (v * Math.cos(a) - manual.vy * Math.sin(a)) * dt
    pose.y += (v * Math.sin(a) + manual.vy * Math.cos(a)) * dt
  }
  // Odometry follows whatever moved the robot, manual input or a tool, and reads zero at rest.
  const a = (pose.yaw * Math.PI) / 180
  const speed = ((pose.x - prev.x) * Math.cos(a) + (pose.y - prev.y) * Math.sin(a)) / dt
  const turn = ((((pose.yaw - prev.yaw) % 360) + 540) % 360) - 180
  prev = { ...pose }
  odo = {
    x: round(pose.x - start.x),
    y: round(pose.y - start.y),
    yaw: round(pose.yaw - start.yaw),
    v: round(speed),
    w: round(turn / dt),
  }
  if (poseSrc.wants()) poseSrc.send({ map: 'office', ...pose })
  if (odoSrc.wants()) odoSrc.send(odo)
  if (scan.wants()) {
    const ranges: (number | null)[] = []
    for (let i = 0; i < 180; i++) {
      const a = ((pose.yaw - 90 + i) * Math.PI) / 180
      let r = 0.1
      while (r < 6 && !walls(pose.x + r * Math.cos(a), pose.y + r * Math.sin(a))) r += 0.05
      ranges.push(r >= 6 ? null : Math.round(r * 100) / 100)
    }
    scan.send({ angle_min: -90, angle_inc: 1, ranges })
  }
}, 200)
setInterval(
  () => grid.wants() && grid.send({ id: 'office', resolution: 0.05, origin: [0, 0] }, gridPng),
  3000,
)
setInterval(() => {
  battery = Math.max(5, battery - 1)
  robot.update({ battery, motor_temp: 41 + Math.round(Math.random() * 30) / 10 })
}, 15000)
robot.onStop = () => {
  manual = { vx: 0, wz: 0, vy: 0 }
}
robot.after = () => ({ odometry: odo, pose: { map: 'office', ...pose } })
robot.onManual = (axes) => {
  manual = { vx: axes.vx ?? 0, wz: axes.wz ?? 0, vy: axes.vy ?? 0 }
  robot.update({ mode: manual.vx || manual.wz || manual.vy ? 'manual' : 'idle' })
}
const driveTo = async (call: Parameters<Parameters<typeof robot.tool>[1]>[0], x: number, y: number) => {
  robot.update({ mode: 'driving' })
  const steps = 20
  const from = { ...pose }
  for (let i = 1; i <= steps; i++) {
    await call.checkpoint()
    await call.sleep(250)
    pose = { ...pose, x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps }
    call.progress({ done: i, total: steps, text: `driving to (${x}, ${y})` })
  }
  robot.update({ mode: 'idle' })
}
robot.tool(
  {
    name: 'drive_to',
    description: 'Drive to a point on the map.',
    timeout: 60,
    params: {
      target: {
        type: 'object',
        description: 'Map point',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        required: ['x', 'y'],
        ui: { pick: 'map-point', label: 'target' },
      },
      speed: { type: 'number', minimum: 0.1, maximum: 0.8, default: 0.4, description: 'm/s' },
    },
    required: ['target'],
    uses: ['chassis'],
    motion: true,
    pausable: true,
  },
  async (call, { target }) => {
    await driveTo(call, target.x, target.y)
    return { detail: `arrived at (${target.x}, ${target.y})` }
  },
)
robot.tool(
  {
    name: 'turn',
    description: 'Turn in place by an angle.',
    timeout: 20,
    params: { angle: { type: 'number', minimum: -180, maximum: 180, description: 'degrees, left positive' } },
    required: ['angle'],
    uses: ['chassis'],
    motion: true,
  },
  async (call, { angle }) => {
    for (let i = 0; i < 10; i++) {
      await call.sleep(150)
      pose = { ...pose, yaw: (pose.yaw + angle / 10 + 360) % 360 }
    }
    return `turned ${angle} degrees`
  },
)
robot.tool(
  {
    name: 'dock',
    description: 'Drive back to the charging dock.',
    timeout: 60,
    uses: ['chassis'],
    motion: true,
  },
  async (call) => {
    await driveTo(call, 1, 1)
    robot.update({ mode: 'docked' })
    return 'docked'
  },
)
robot.tool(
  {
    name: 'say',
    description: 'Say a sentence through the speaker.',
    timeout: 20,
    params: { text: { type: 'string', maxLength: 200 } },
    required: ['text'],
    uses: ['speaker'],
  },
  async (call, { text }) => {
    await call.sleep(800)
    return `said "${text}"`
  },
)

// --- lamp-01 ---
const lamp = new Device({
  id: 'lamp-01',
  kind: 'lamp',
  name: 'Desk lamp',
  state: {
    on: { type: 'boolean', writable: true },
    brightness: { type: 'integer', unit: '%', min: 0, max: 100, writable: true, ui: { tile: true } },
    color: { type: 'string', enum: ['warm', 'neutral', 'cool'], writable: true, ui: { tile: true } },
    power: { type: 'number', unit: 'W', role: 'power' },
  },
})
lamp.update({ on: true, brightness: 60, color: 'warm', power: 4.2 })
lamp.onSet = (name, value) => {
  const next = { ...lamp.state, [name]: value }
  setTimeout(() => lamp.update({ power: next.on ? Math.round(Number(next.brightness) * 0.07 * 10) / 10 : 0 }))
  return undefined
}
lamp.tool(
  {
    name: 'blink',
    description: 'Blink a few times.',
    timeout: 10,
    params: { times: { type: 'integer', minimum: 1, maximum: 5, default: 3 } },
  },
  async (call, { times }) => {
    for (let i = 0; i < (times ?? 3); i++) {
      lamp.update({ on: false })
      await call.sleep(200)
      lamp.update({ on: true })
      await call.sleep(200)
    }
    return `blinked ${times ?? 3} times`
  },
)

// --- env-01 ---
const env = new Device({
  id: 'env-01',
  kind: 'sensor',
  name: 'Room sensor',
  localization: 'fixed',
  placement: { map: 'office', x: 7.3, y: 5.3, yaw: 225 },
})
const air = env.source('air', 'values', 'air in the room', {
  hz: 1,
  fields: {
    temperature: { type: 'number', unit: '°C', role: 'temperature', min: -10, max: 50 },
    humidity: { type: 'number', unit: '%', min: 0, max: 100 },
    co2: { type: 'integer', unit: 'ppm', min: 300, max: 3000, alert: { warn: 1000, bad: 1500 } },
  },
})
const door = env.source('door', 'switch', 'door contact', { fields: { open: { type: 'boolean' } } })
let co2 = 700
setInterval(() => {
  co2 = co2 > 1700 ? 700 : co2 + 15
  air.send({ temperature: 22 + Math.sin(Date.now() / 60000) * 2, humidity: 41 + Math.random() * 2, co2 })
  door.send({ open: Math.floor(Date.now() / 20000) % 3 === 0 })
}, 1000)

// --- arm-01 ---
const arm = new Device({
  id: 'arm-01',
  kind: 'arm',
  name: 'Arm',
  resources: { arm: 'reject' },
  manual: {
    axes: [
      { id: 'j1', role: 'joint', joint: 1, unit: 'deg/s', min: -30, max: 30 },
      { id: 'j2', role: 'joint', joint: 2, unit: 'deg/s', min: -30, max: 30 },
      { id: 'z', role: 'up', unit: 'm/s', min: -0.05, max: 0.05 },
      { id: 'g', role: 'grip', unit: '%', min: -50, max: 50 },
    ],
    rate_hz: 10,
    deadman_s: 0.5,
  },
  state: {
    gripper: { type: 'string', enum: ['open', 'closed', 'holding'] },
    load: { type: 'number', unit: 'kg', min: 0, max: 2, alert: { warn: 1.5, bad: 1.9 } },
  },
})
arm.update({ gripper: 'open', load: 0 })
const mic = arm.source('mic', 'audio', 'microphone at the gripper', {
  hz: 25,
  rate: 16000,
  channels: 1,
  switchable: true,
})
const log = arm.source('log', 'text', 'controller log')
let tone = 0
setInterval(() => {
  if (!mic.wants()) return
  const pcm = new Int16Array(640)
  for (let i = 0; i < pcm.length; i++)
    pcm[i] = Math.round(Math.sin((tone++ * 2 * Math.PI * 220) / 16000) * 3000)
  mic.send({ rate: 16000, channels: 1 }, new Uint8Array(pcm.buffer))
}, 40)
arm.tool(
  {
    name: 'home',
    description: 'Move every joint to its home position.',
    timeout: 20,
    uses: ['arm'],
    motion: true,
  },
  async (call) => {
    for (let i = 1; i <= 4; i++) {
      await call.sleep(400)
      call.progress({ done: i, total: 4, text: `joint ${i} home` })
    }
    log.send({ text: 'homed' })
    return 'all joints home'
  },
)
arm.tool(
  {
    name: 'pick',
    description: 'Pick an object at a position in front of the arm.',
    timeout: 30,
    params: {
      x: { type: 'number', minimum: 0.1, maximum: 0.6 },
      y: { type: 'number', minimum: -0.3, maximum: 0.3 },
      z: { type: 'number', minimum: 0, maximum: 0.4 },
    },
    required: ['x', 'y', 'z'],
    uses: ['arm'],
    motion: true,
    ui: { confirm: true },
  },
  async (call, { x, y, z }) => {
    await call.sleep(1500)
    arm.update({ gripper: 'holding', load: 0.4 })
    log.send({ text: `picked at (${x}, ${y}, ${z})` })
    return { detail: 'holding the object', data: { weight_kg: 0.4 } }
  },
)

const only = process.env.DEV_DEVICES?.split(',')
const devices = [robot, lamp, env, arm].filter((d) => !only || only.includes(d.id))
for (const d of devices) void d.run(url)
await sleep(300)
const names = devices.map((d) => d.id).join(', ')
console.log(
  elsewhere
    ? `devices ${names} connected to ${elsewhere}`
    : `development AgnesHub on http://127.0.0.1:${port}/ (devices: ${names})`,
)

// Health and position by hand, to see the panel react.
process.stdin.setEncoding('utf8')
process.stdin.on('data', (line: string) => {
  const [what, , how] = line.trim().split(/\s+/)
  if (what === 'health') robot.update({ motor_temp: how === 'hot' ? 88 : 45 })
  if (what === 'pose') pose = { ...pose, ok: how !== 'lost' }
  if (what === 'battery') robot.update({ battery: Number(how) })
})
