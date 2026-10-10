import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { Device } from '../device/device.js'
import { Maps, zoneAt } from '../server/maps.js'
import { North, resultText } from '../server/north.js'
import { South } from '../server/south.js'
import { FakeDevice, FakeNerve, type Msg, until } from './fakes.js'

/** A client of the AgnesHub API: requests in order, notifications and binary frames kept. */
class Client {
  readonly notes: (Msg | Buffer)[] = []
  private readonly replies = new Map<string, (m: Msg) => void>()
  private next = 0

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return void this.notes.push(data as Buffer)
      const m = JSON.parse(data.toString()) as Msg
      const reply = m.id === undefined ? undefined : this.replies.get(m.id)
      if (reply) reply(m)
      else this.notes.push(m)
    })
  }

  static async open(base: string, hello: Msg | null = { role: 'agent', client: { name: 'brain' } }) {
    const ws = new WebSocket(base.replace('/ws/mhs', '/ws/hub'))
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const client = new Client(ws)
    if (hello) await client.request('hub/hello', hello)
    return client
  }

  request(method: string, params: Msg = {}): Promise<Msg> {
    this.next += 1
    const id = `r${this.next}`
    return new Promise((resolve) => {
      this.replies.set(id, resolve)
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  notifications(method: string): Msg[] {
    return this.notes.filter((m): m is Msg => !Buffer.isBuffer(m) && m.method === method)
  }
}

const ROBOT = {
  protocol: 'mhs/v1',
  device: { id: 'robot-01', kind: 'robot', name: 'Robot' },
  state: {
    mode: { type: 'string', enum: ['idle', 'driving'] },
    battery: { type: 'number', unit: '%', role: 'battery', alert: { warn: 20, bad: 10, below: true } },
  },
  sources: [
    { id: 'front_video', kind: 'video', codec: 'h264', gop_s: 1, description: 'front camera, video' },
    { id: 'front', kind: 'image', mime: 'image/jpeg', description: 'front camera, stills' },
    {
      id: 'objects',
      kind: 'detections',
      of: 'front',
      model: { name: 'example-det', version: '1' },
      description: 'objects in the front camera',
    },
    {
      id: 'motors',
      kind: 'values',
      description: 'drive motors',
      fields: {
        temperature: {
          type: 'number',
          unit: '°C',
          role: 'temperature',
          of: 'motor',
          alert: { warn: 70, bad: 85 },
        },
      },
    },
  ],
}

let south: South
let north: North
let base: string

beforeEach(async () => {
  south = new South({ timing: { accept: 200, grace: 100, control: 200 } })
  north = new North(south)
  const address = await south.listen(0, '127.0.0.1', north.handleUpgrade)
  base = `ws://127.0.0.1:${address.port}/ws/mhs`
})

afterEach(async () => {
  north.close()
  await south.close()
})

async function robot(): Promise<{ device: FakeDevice; nerve: FakeNerve }> {
  const device = await FakeDevice.open(base)
  await device.register(ROBOT)
  const online = new Promise((resolve) => south.once('online', resolve))
  const nerve = await FakeNerve.open(base, { type: 'hello', device: 'robot-01' })
  await online
  // The fake device's clock runs 100 s ahead; wait until the hub has measured it.
  await until(() => Math.abs(south.hubTime('robot-01', 1100) - 1000) < 1)
  device.notify('mhs/state', {
    t: deviceNow(),
    values: { mode: 'idle', battery: 15, problem: null, faults: [] },
  })
  await until(() => south.state('robot-01')?.values.battery === 15)
  return { device, nerve }
}

const deviceNow = () => Date.now() / 1000 + 100

const data = (source: string, seq: number, payload: Msg, bin = false): Msg => ({
  type: 'data',
  source,
  seq,
  t: deviceNow(),
  data: payload,
  ...(bin ? { bin: true } : {}),
})

describe('sessions', () => {
  it('wants hub/hello first and names the caller by role', async () => {
    const client = await Client.open(base, null)
    expect((await client.request('hub/devices')).error.code).toBe(-32600)
    expect((await client.request('hub/hello', { role: 'robot' })).error.code).toBe(-32602)
    const ui = await client.request('hub/hello', { role: 'ui', client: { name: 'devices-panel' } })
    expect(ui.result).toMatchObject({ caller: { name: 'web', level: 1 }, hub: { name: 'agnes-hub' } })
    const agent = await Client.open(base, null)
    expect(
      (await agent.request('hub/hello', { role: 'agent', client: { name: 'brain' } })).result.caller,
    ).toEqual({
      name: 'brain',
      level: 2,
    })
  })
})

describe('devices and state', () => {
  it('lists devices with their state, and keeps them listed after they go', async () => {
    const client = await Client.open(base)
    const { device } = await robot()
    const [entry] = (await client.request('hub/devices')).result.devices
    expect(entry).toMatchObject({
      id: 'robot-01',
      kind: 'robot',
      name: 'Robot',
      online: true,
      available: true,
      state: { values: { mode: 'idle', battery: 15 }, alerts: { battery: 'warn' } },
    })
    expect(entry.state.fields.battery.role).toBe('battery')
    expect(entry.protocol).toBeUndefined()
    device.ws.close()
    await until(() => south.devices().length === 0)
    const [gone] = (await client.request('hub/devices')).result.devices
    expect(gone).toMatchObject({
      id: 'robot-01',
      online: false,
      available: false,
      state: { values: { battery: 15 } },
    })
  })

  it('tells every client when devices change and when their state changes', async () => {
    const client = await Client.open(base)
    const { device } = await robot()
    await until(() => client.notifications('hub/state').length > 0)
    expect(client.notifications('hub/changed')[0]?.params.devices[0]).toMatchObject({
      id: 'robot-01',
      available: true,
    })
    device.notify('mhs/state', { t: deviceNow(), values: { mode: 'driving' } })
    await until(() => client.notifications('hub/state').some((n) => n.params.values.mode === 'driving'))
    const last = client.notifications('hub/state').at(-1)
    expect(last?.params).toMatchObject({ device: 'robot-01', values: { mode: 'driving' } })
    expect(typeof last?.params.time).toBe('number')
  })

  it('rejects an unknown device', async () => {
    const client = await Client.open(base)
    expect((await client.request('hub/read', { device: 'nobody' })).error.code).toBe(-32005)
  })
})

describe('hub/read', () => {
  it('reads state by default, with a sentence for a model', async () => {
    const client = await Client.open(base)
    await robot()
    const { result } = await client.request('hub/read', { device: 'robot-01' })
    expect(result.items).toEqual([])
    expect(result.state.values).toMatchObject({ mode: 'idle', battery: 15 })
    expect(result.text).toBe(
      'robot-01 is available. Attention: battery 15 % (warn 20). State: mode idle, battery 15 %.',
    )
  })

  it('adds the newest item of each source asked for; video is refused, pictures come as base64', async () => {
    const client = await Client.open(base)
    const { nerve } = await robot()
    nerve.send(data('front', 0, { w: 640, h: 480 }, true))
    nerve.send(Buffer.from([0xff, 0xd8, 0x01]))
    nerve.send(
      data('objects', 0, {
        w: 640,
        h: 480,
        items: [{ label: 'box', conf: 0.9, box: [1, 1, 9, 9], dist: 2.14, bearing: -5 }],
      }),
    )
    nerve.send(data('motors', 0, { temperature: 72 }))
    await until(() => south.latest('robot-01', 'motors') !== undefined)
    const { result } = await client.request('hub/read', {
      device: 'robot-01',
      sources: ['front', 'objects', 'motors', 'front_video', 'lidar'],
    })
    const [front, objects, motors, video, lidar] = result.items
    expect(front).toMatchObject({ source: 'front', kind: 'image', seq: 0, mime: 'image/jpeg', b64: '/9gB' })
    expect(front.text).toMatch(/^robot-01 front: picture 640x480, [\d.]+ s old\.$/)
    expect(objects.text).toMatch(/^robot-01 objects: box 0\.9 \(2\.1 m, 5° right\)/)
    expect(motors.text).toMatch(/^robot-01 motors: temperature 72 °C/)
    expect(video.error).toMatch(/video is for watching/)
    expect(lidar.error).toBe('no such source')
  })

  it('waits for data newer than since, and returns values history on request', async () => {
    const client = await Client.open(base)
    const { nerve } = await robot()
    nerve.send(data('motors', 0, { temperature: 40 }))
    await until(() => south.latest('robot-01', 'motors') !== undefined)
    const since = Date.now() / 1000 + 0.01
    const reading = client.request('hub/read', {
      device: 'robot-01',
      sources: ['motors'],
      since,
      history: true,
    })
    await new Promise((r) => setTimeout(r, 50))
    nerve.send(data('motors', 1, { temperature: 41 }))
    const { result } = await reading
    expect(result.items[0]).toMatchObject({ seq: 1, data: { temperature: 41 } })
    expect(result.items[0].history.map((h: Msg) => h.data.temperature)).toEqual([40])
    const late = await client.request('hub/read', { device: 'robot-01', sources: ['front'], since })
    expect(late.result.items[0].error).toBe('nothing newer arrived within 2 s')
  }, 5000)
})

describe('hub/subscribe', () => {
  it('streams items, at most hz a second, with binary frames on request', async () => {
    const client = await Client.open(base)
    const { nerve } = await robot()
    const { result } = await client.request('hub/subscribe', {
      device: 'robot-01',
      sources: ['front', 'motors'],
      hz: 5,
      binary: true,
    })
    nerve.send(data('front', 0, { w: 2, h: 2 }, true))
    nerve.send(Buffer.from([0xff, 0xd8]))
    for (let i = 0; i < 3; i++) nerve.send(data('motors', i, { temperature: 50 + i }))
    await until(() => client.notifications('hub/data').length === 2)
    const [picture, motors] = client.notifications('hub/data')
    expect(picture?.params).toMatchObject({
      sub: result.sub,
      device: 'robot-01',
      item: { source: 'front', bin: true },
    })
    expect(picture?.params.item.b64).toBeUndefined()
    expect(client.notes[client.notes.indexOf(picture as Msg) + 1]).toEqual(Buffer.from([0xff, 0xd8]))
    // Five a second: the second and third motors items came too soon.
    expect(motors?.params.item).toMatchObject({ source: 'motors', seq: 0 })
    expect((await client.request('hub/unsubscribe', { sub: result.sub })).result).toEqual({})
    expect((await client.request('hub/unsubscribe', { sub: result.sub })).error.code).toBe(-32005)
  })

  it('starts video at a keyframe and asks the device for one', async () => {
    const client = await Client.open(base)
    const { device, nerve } = await robot()
    await client.request('hub/subscribe', { device: 'robot-01', sources: ['front_video'] })
    // Demand sends mhs/configure as well; answer it and look for the keyframe request.
    let ask = await device.next()
    while (ask.method === 'mhs/configure') {
      device.reply(ask.id, { sources: {} })
      ask = await device.next()
    }
    expect(ask).toMatchObject({ method: 'mhs/keyframe', params: { sources: ['front_video'] } })
    device.reply(ask.id, { sources: ['front_video'] })
    nerve.send(data('front_video', 0, { key: false, w: 2, h: 2 }, true))
    nerve.send(Buffer.from([0, 0, 0, 1, 0x41]))
    nerve.send(data('front_video', 1, { key: true, w: 2, h: 2 }, true))
    nerve.send(Buffer.from([0, 0, 0, 1, 0x65]))
    await until(() => client.notifications('hub/data').length === 1)
    expect(client.notifications('hub/data')[0]?.params.item).toMatchObject({ seq: 1, b64: 'AAAAAWU=' })
  })

  it('refuses unknown sources', async () => {
    const client = await Client.open(base)
    await robot()
    const reply = await client.request('hub/subscribe', { device: 'robot-01', sources: ['lidar'] })
    expect(reply.error).toMatchObject({ code: -32005, message: 'robot-01 has no source lidar' })
  })
})

/** A device built with the TypeScript Device library, for calls end to end. */
function mover(): Device {
  const dev = new Device({
    id: 'mover-01',
    kind: 'robot',
    mobile: true,
    resources: { chassis: 'reject' },
    state: { speed: { type: 'number', unit: 'm/s', min: 0.1, max: 1, writable: true } },
  })
  dev.update({ speed: 0.5 })
  dev.after = () => ({ pose: { map: 'office', x: 1.234, y: -2, yaw: 90.4, ok: true } })
  dev.tool(
    {
      name: 'move',
      description: 'Drive straight.',
      timeout: 10,
      params: { x: { type: 'number', minimum: -2, maximum: 2 } },
      required: ['x'],
      uses: ['chassis'],
      motion: true,
      pausable: true,
    },
    async (call, { x }) => {
      for (let i = 0; i < 40; i++) {
        await call.checkpoint()
        call.progress({ done: i, total: 40 })
        await call.sleep(10)
      }
      return `moved ${x} m`
    },
  )
  return dev
}

describe('calls and control (N2)', () => {
  let dev: Device
  beforeEach(async () => {
    dev = mover()
    void dev.run(base.replace('/ws/mhs', ''))
    await until(() => south.devices().some((d) => d.id === 'mover-01' && d.available))
  })
  afterEach(() => dev.close())

  it('runs a job: accepted, progress, then one result to the caller, with clamping notes and a sentence', async () => {
    const client = await Client.open(base)
    const reply = await client.request('hub/call', { device: 'mover-01', tool: 'move', arguments: { x: 5 } })
    expect(reply.result).toEqual({ accepted: true, job: 'j1' })
    const [entry] = (await client.request('hub/devices')).result.devices
    expect(entry.busy).toEqual({ chassis: { job: 'j1', tool: 'move', caller: 'brain' } })
    await until(() => client.notifications('hub/result').length === 1)
    expect(client.notifications('hub/progress')[0]?.params).toMatchObject({ job: 'j1', total: 40 })
    const result = client.notifications('hub/result')[0]?.params
    expect(result).toMatchObject({
      job: 'j1',
      device: 'mover-01',
      tool: 'move',
      status: 'done',
      notes: ['x was 5, clamped to 2'],
    })
    expect(result.text).toBe(
      'mover-01: moved 2 m. Notes: x was 5, clamped to 2. Now at (1.23, -2) facing 90 degrees.',
    )
    expect((await client.request('hub/job', { job: 'j1' })).result).toMatchObject({
      caller: 'brain',
      state: 'ended',
      result: { status: 'done' },
    })
  })

  it('names the job, tool and caller that hold a resource', async () => {
    const web = await Client.open(base, { role: 'ui' })
    const brain = await Client.open(base)
    await web.request('hub/call', { device: 'mover-01', tool: 'move', arguments: { x: 1 } })
    const { result } = await brain.request('hub/call', {
      device: 'mover-01',
      tool: 'move',
      arguments: { x: 1 },
    })
    expect(result).toMatchObject({
      accepted: false,
      reason: 'busy',
      holder: { job: 'j1', tool: 'move', caller: 'web' },
    })
    expect(result.text).toBe(
      'mover-01 is busy: chassis held by move j1 (web). Try later, or stop or cancel that first.',
    )
  })

  it('cancels, stops, pauses and resumes jobs', async () => {
    const client = await Client.open(base)
    await client.request('hub/call', { device: 'mover-01', tool: 'move', arguments: { x: 1 } })
    expect((await client.request('hub/pause', { job: 'j1' })).result).toEqual({ paused: true })
    expect((await client.request('hub/job', { job: 'j1' })).result.state).toBe('paused')
    expect((await client.request('hub/resume', { job: 'j1' })).result).toEqual({ resumed: true })
    expect((await client.request('hub/cancel', { job: 'j1' })).result).toEqual({ cancelled: true })
    await until(() => client.notifications('hub/result').length === 1)
    expect(client.notifications('hub/result')[0]?.params).toMatchObject({
      status: 'interrupted',
      reason: 'cancel',
    })
    await client.request('hub/call', { device: 'mover-01', tool: 'move', arguments: { x: 1 } })
    expect((await client.request('hub/stop', {})).result).toEqual({ stopped: ['j2'] })
    expect((await client.request('hub/cancel', { job: 'nope' })).error.code).toBe(-32005)
  })

  it('rejects calls the hub can judge itself', async () => {
    const client = await Client.open(base)
    const { result } = await client.request('hub/call', { device: 'mover-01', tool: 'fly', arguments: {} })
    expect(result).toMatchObject({ accepted: false, reason: 'invalid', detail: 'mover-01 has no tool fly' })
    expect(result.text).toBe('mover-01 rejected fly (invalid): mover-01 has no tool fly.')
  })

  it('changes writable state through hub/set', async () => {
    const client = await Client.open(base)
    const { result } = await client.request('hub/set', { device: 'mover-01', values: { speed: 3, ghost: 1 } })
    expect(result).toMatchObject({ values: { speed: 1 }, refused: { ghost: 'not a state field' } })
    expect(result.text).toBe(
      'mover-01: speed 1 m/s. speed was 3, clamped to 1. Refused: ghost not a state field.',
    )
  })
})

const LOCATED = {
  protocol: 'mhs/v1',
  device: { id: 'scout-01', kind: 'robot' },
  localization: 'self',
  sources: [
    {
      id: 'pose',
      kind: 'pose',
      hz: 5,
      model: { name: 'slam', version: '1' },
      max_error_m: 0.5,
      description: 'where it is',
    },
    { id: 'odom', kind: 'odometry', hz: 5, description: 'wheel odometry' },
  ],
}

async function scout(): Promise<{ device: FakeDevice; nerve: FakeNerve }> {
  const device = await FakeDevice.open(base)
  await device.register(LOCATED)
  const online = new Promise((resolve) => south.once('online', resolve))
  const nerve = await FakeNerve.open(base, { type: 'hello', device: 'scout-01' })
  await online
  await until(() => Math.abs(south.hubTime('scout-01', 1100) - 1000) < 1)
  return { device, nerve }
}

describe('health and position (N3)', () => {
  it('summarizes health from alerts, problems and faults, naming fields by role', async () => {
    const client = await Client.open(base)
    const { device, nerve } = await robot()
    nerve.send(data('motors', 0, { temperature: 72 }))
    device.notify('mhs/state', {
      t: deviceNow(),
      values: { problem: 'left wheel slipping', faults: ['E12'] },
    })
    await until(() => south.state('robot-01')?.values.problem === 'left wheel slipping')
    const { result } = await client.request('hub/read', { device: 'robot-01' })
    expect(result.health).toEqual({
      level: 'attention',
      reasons: [
        'battery 15 % (warn 20)',
        'motor temperature 72 °C (warn 70)',
        'left wheel slipping',
        'faults: E12',
      ],
    })
    expect(result.position).toBeUndefined()
    // Pages are told within a second, without asking, and see the traffic.
    await until(() =>
      client.notes.some(
        (n) =>
          !Buffer.isBuffer(n) &&
          n.method === 'hub/traffic' &&
          ((n.params as { devices: Record<string, { nerve_up: number }> }).devices['robot-01']?.nerve_up ??
            0) > 0,
      ),
    )
    await until(() =>
      client.notes.some(
        (n) =>
          !Buffer.isBuffer(n) &&
          n.method === 'hub/changed' &&
          (n.params as { devices: { health: { reasons: string[] } }[] }).devices[0]?.health.reasons.length ===
            4,
      ),
    )
  })

  it('judges position trust from ok, the error, odometry and age', async () => {
    const client = await Client.open(base)
    const { nerve } = await scout()
    const read = async () => (await client.request('hub/read', { device: 'scout-01' })).result.position
    expect(await read()).toEqual({ trust: 'lost', reason: 'no position yet' })
    nerve.send(data('odom', 0, { x: 0, y: 0, yaw: 0, v: 0, w: 0 }))
    nerve.send(data('pose', 0, { map: 'office', x: 1, y: 2, yaw: 90, ok: true }))
    await until(() => south.latest('scout-01', 'pose') !== undefined)
    expect(await read()).toMatchObject({ trust: 'trusted', map: 'office', x: 1, y: 2, yaw: 90 })
    nerve.send(
      data('pose', 1, { map: 'office', x: 1, y: 2, yaw: 90, ok: true, cov: [1, 0, 0, 0, 1, 0, 0, 0, 0] }),
    )
    await until(() => south.latest('scout-01', 'pose')?.msg.seq === 1)
    expect(await read()).toMatchObject({ trust: 'uncertain', reason: 'position error 1 m, over 0.5 m' })
    nerve.send(data('pose', 2, { map: 'office', x: 5, y: 2, yaw: 90, ok: true }))
    await until(() => south.latest('scout-01', 'pose')?.msg.seq === 2)
    expect(await read()).toMatchObject({
      trust: 'uncertain',
      reason: 'jumped 4.0 m while odometry moved 0.0 m',
    })
    nerve.send(data('pose', 3, { map: 'office', x: 5, y: 2, yaw: 90, ok: false }))
    await until(() => south.latest('scout-01', 'pose')?.msg.seq === 3)
    expect(await read()).toMatchObject({ trust: 'uncertain', reason: 'the device does not trust its fix' })
    const { result } = await client.request('hub/read', { device: 'scout-01' })
    expect(result.text).toBe(
      'scout-01 is available. Position uncertain: (5, 2) facing 90° on map office, the device does not trust its fix.',
    )
  })
})

describe('events (N3)', () => {
  it('sends alert, job and health events to subscribers, and replays them with since', async () => {
    const client = await Client.open(base)
    const { result } = await client.request('hub/subscribe', { events: ['alert', 'health'] })
    const { nerve } = await robot()
    nerve.send(data('motors', 0, { temperature: 72 }))
    await until(() => client.notifications('hub/event').some((n) => n.params.event.data.source === 'motors'))
    const alert = client
      .notifications('hub/event')
      .find((n) => n.params.event.data.source === 'motors')?.params
    expect(alert.sub).toBe(result.sub)
    expect(alert.event).toMatchObject({
      device: 'robot-01',
      level: 'warning',
      text: 'robot-01: motor temperature 72 °C, past warn 70 °C.',
      data: {
        source: 'motors',
        field: 'temperature',
        role: 'temperature',
        of: 'motor',
        value: 72,
        alert: 'warn',
      },
    })
    const late = await Client.open(base)
    const all = (await late.request('hub/subscribe', { events: true, since: 'e0' })).result
    expect(all.sub).toMatch(/^s/)
    await until(() => late.notifications('hub/event').length > 0)
    expect(late.notifications('hub/event').map((n) => n.params.event.type)).toContain('online')
  })
})

describe('watch (N3)', () => {
  it('fires once when new state, data or health satisfies the condition, with the note', async () => {
    const client = await Client.open(base)
    const { device, nerve } = await robot()
    const w1 = (
      await client.request('hub/watch', {
        device: 'robot-01',
        until: { state: 'mode', eq: 'driving' },
        note: 'wait to leave',
      })
    ).result.watch
    const w2 = (
      await client.request('hub/watch', { device: 'robot-01', until: { source: 'objects', has: 'person' } })
    ).result.watch
    device.notify('mhs/state', { t: deviceNow(), values: { mode: 'driving' } })
    nerve.send(data('objects', 0, { w: 2, h: 2, items: [{ label: 'person', conf: 0.4, box: [0, 0, 1, 1] }] }))
    nerve.send(data('objects', 1, { w: 2, h: 2, items: [{ label: 'person', conf: 0.8, box: [0, 0, 1, 1] }] }))
    await until(() => client.notifications('hub/event').length === 2)
    const [first, second] = client.notifications('hub/event').map((n) => n.params.event)
    expect(first).toMatchObject({
      type: 'watch',
      text: 'robot-01: mode = driving (wait to leave).',
      data: { watch: w1, matched: true },
    })
    expect(second).toMatchObject({
      type: 'watch',
      text: 'robot-01: objects saw person.',
      data: { watch: w2, matched: true },
    })
    expect(second.data.item.items[0].conf).toBe(0.8)
    expect((await client.request('hub/unwatch', { watch: w1 })).error.code).toBe(-32005)
  })

  it('times out with matched false, and refuses conditions it cannot check', async () => {
    const client = await Client.open(base)
    await robot()
    await client.request('hub/watch', { device: 'robot-01', until: { state: 'battery', lt: 5 }, timeout: 1 })
    await until(() => client.notifications('hub/event').length === 1, 3000)
    expect(client.notifications('hub/event')[0]?.params.event).toMatchObject({
      text: 'robot-01: waited 1 s and battery < 5 did not happen.',
      data: { matched: false },
    })
    const bad = async (until: Msg) =>
      (await client.request('hub/watch', { device: 'robot-01', until })).error?.message
    expect(await bad({ state: 'speed', lt: 1 })).toBe('robot-01 has no state field speed')
    expect(await bad({ source: 'front', has: 'person' })).toBe('front is not a detections source')
    expect(await bad({ trust: 'lost' })).toBe('robot-01 has no position')
  })
})

describe('manual control, switches and demand (N4)', () => {
  let dev: Device
  let cam: ReturnType<Device['source']>
  let pose: ReturnType<Device['source']>
  let mic: ReturnType<Device['source']>
  const manual: Record<string, number>[] = []
  let feeder: NodeJS.Timeout

  beforeEach(async () => {
    manual.length = 0
    dev = new Device({
      id: 'cart-01',
      kind: 'robot',
      mobile: true,
      localization: 'self',
      manual: {
        axes: [{ id: 'vx', role: 'forward', unit: 'm/s', min: -0.5, max: 0.5 }],
        rate_hz: 10,
        deadman_s: 0.5,
      },
    })
    cam = dev.source('cam', 'image', 'front camera', { mime: 'image/jpeg', hz: 10 })
    pose = dev.source('pose', 'pose', 'where it is', { hz: 5, model: { name: 'slam', version: '1' } })
    mic = dev.source('mic', 'audio', 'microphone', { rate: 16000, channels: 1, switchable: true, hz: 10 })
    dev.onManual = (axes) => {
      manual.push(axes)
    }
    feeder = setInterval(() => {
      if (cam.wants()) cam.send({ w: 2, h: 2 }, new Uint8Array([0xff, 0xd8]))
      if (pose.wants()) pose.send({ map: 'office', x: 0, y: 0, yaw: 0, ok: true })
      if (mic.wants()) mic.send({ rate: 16000, channels: 1 }, new Uint8Array([0, 0]))
    }, 20)
    void dev.run(base.replace('/ws/mhs', ''))
    await until(() => south.devices().some((d) => d.id === 'cart-01' && d.available))
  })
  afterEach(() => {
    clearInterval(feeder)
    dev.close()
  })

  it('keeps only what someone uses on: pose at 1 Hz, subscriptions at their rate, nothing else', async () => {
    await until(() => !cam.on && pose.on && pose.hz === 1)
    const client = await Client.open(base)
    const { result } = await client.request('hub/subscribe', { device: 'cart-01', sources: ['cam'], hz: 4 })
    await until(() => cam.on && cam.hz === 4)
    await client.request('hub/unsubscribe', { sub: result.sub })
    await until(() => !cam.on)
  })

  it('turns a source on for a read and waits for its data', async () => {
    await until(() => !cam.on)
    const client = await Client.open(base)
    const { result } = await client.request('hub/read', { device: 'cart-01', sources: ['cam'] })
    expect(result.items[0]).toMatchObject({ source: 'cam', mime: 'image/jpeg', b64: '/9g=' })
    expect(cam.on).toBe(true)
  })

  it('keeps a source switched off by hand off, whatever the demand', async () => {
    const client = await Client.open(base, { role: 'ui' })
    expect(
      (await client.request('hub/configure', { device: 'cart-01', sources: { mic: { on: false } } })).result,
    ).toEqual({
      sources: { mic: { on: false } },
    })
    await client.request('hub/subscribe', { device: 'cart-01', sources: ['mic'] })
    const { result } = await client.request('hub/read', { device: 'cart-01', sources: ['mic'] })
    expect(result.items[0].error).toBe('switched off by hand')
    expect(mic.on).toBe(false)
    expect(north.devices().find((d) => d.id === 'cart-01')?.off).toEqual(['mic'])
    expect(
      (await client.request('hub/configure', { device: 'cart-01', sources: { cam: { on: false } } })).error
        .message,
    ).toBe('cam is not switchable')
  })

  it('forwards manual input clamped, reports the takeover, and zeroes it when the page goes', async () => {
    const page = await Client.open(base, { role: 'ui' })
    const watcher = await Client.open(base)
    await watcher.request('hub/subscribe', { events: ['manual'] })
    page.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'hub/manual',
        params: { device: 'cart-01', axes: { vx: 3 } },
      }),
    )
    await until(() => manual.some((a) => a.vx === 0.5))
    await until(() => watcher.notifications('hub/event').length === 1)
    expect(watcher.notifications('hub/event')[0]?.params.event).toMatchObject({
      type: 'manual',
      text: 'cart-01 taken over by hand (web).',
    })
    page.ws.close()
    await until(() => manual.at(-1)?.vx === 0)
  })
})

/** A fixed device that declares a map, with no sources, so it needs no Nerve channel. */
const SITE = {
  protocol: 'mhs/v1',
  device: { id: 'gate-01', kind: 'sensor', name: 'Gate camera' },
  localization: 'fixed',
  placement: { map: 'site', x: 2, y: 3, yaw: 90 },
  maps: [
    {
      id: 'site',
      name: 'Site',
      bounds: [0, 0, 20, 10],
      places: [
        { id: 'gate', name: 'Gate', at: [1, 3], yaw: 180, description: 'The way in' },
        {
          id: 'yard',
          name: 'Yard',
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
        },
      ],
    },
  ],
}

async function site(description: Msg = SITE): Promise<FakeDevice> {
  const device = await FakeDevice.open(base)
  const online = new Promise((resolve) => south.once('online', resolve))
  await device.register(description)
  await online
  return device
}

describe('maps', () => {
  it('keeps declared maps after their devices go; the latest frame wins, places merge by id', async () => {
    const first = await site()
    first.ws.close()
    await until(() => south.devices().length === 0)
    expect(north.maps.get('site')).toMatchObject({ name: 'Site', bounds: [0, 0, 20, 10] })
    await site({
      ...SITE,
      device: { id: 'gate-02', kind: 'sensor' },
      maps: [
        {
          id: 'site',
          name: 'Site plan',
          places: [
            { id: 'gate', name: 'Main gate', at: [1, 3] },
            { id: 'shed', name: 'Shed', at: [15, 8] },
          ],
        },
      ],
    })
    const map = north.maps.get('site')
    expect(map?.name).toBe('Site plan')
    expect(map?.bounds).toBeUndefined()
    expect(map?.places?.map((p) => `${p.id} ${p.name}`)).toEqual(['gate Main gate', 'yard Yard', 'shed Shed'])
  })

  it('gives a fixed device its placement as a trusted position, with the zone it is in', async () => {
    const client = await Client.open(base)
    await site()
    const { result } = await client.request('hub/read', { device: 'gate-01' })
    expect(result.position).toEqual({
      trust: 'trusted',
      map: 'site',
      x: 2,
      y: 3,
      yaw: 90,
      fixed: true,
      zone: 'yard',
    })
    expect(result.text).toBe(
      'gate-01 is available. Installed at (2, 3) facing 90° on map site, in zone Yard (yard).',
    )
  })

  it('gives every known map as a world with its devices and places, and tells clients when maps change', async () => {
    const client = await Client.open(base)
    await site()
    await until(() => client.notifications('hub/world').length === 1)
    const { result } = await client.request('hub/world')
    expect(result).toEqual({
      worlds: [
        {
          map: 'site',
          name: 'Site',
          bounds: [0, 0, 20, 10],
          entities: [{ device: 'gate-01', x: 2, y: 3, yaw: 90, ok: true, fixed: true, zone: 'yard' }],
          places: SITE.maps[0]?.places,
        },
      ],
    })
    // The same declaration again changes nothing, so nobody is told.
    await site({ ...SITE, device: { id: 'gate-02', kind: 'sensor' } })
    await client.request('hub/devices')
    expect(client.notifications('hub/world')).toHaveLength(1)
  })

  it('keeps maps in a file when it has one', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mhs-maps-')), 'maps.json')
    const maps = new Maps(file)
    expect(maps.declare(SITE.maps)).toBe(true)
    expect(maps.declare(SITE.maps)).toBe(false)
    expect(new Maps(file).get('site')?.places).toHaveLength(2)
  })

  it('finds the zone a point is in, the smaller of nested zones', () => {
    const map = {
      id: 'm',
      places: [
        {
          id: 'all',
          name: 'All',
          points: [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
          ],
        },
        {
          id: 'corner',
          name: 'Corner',
          points: [
            [0, 0],
            [2, 0],
            [2, 2],
          ],
        },
      ],
    }
    expect(zoneAt(map, 1.5, 0.5)?.id).toBe('corner')
    expect(zoneAt(map, 5, 5)?.id).toBe('all')
    expect(zoneAt(map, 11, 5)).toBeUndefined()
  })
})

describe('result text', () => {
  it('says how a job ended once', () => {
    expect(
      resultText('cam-1', 'look_at', {
        status: 'interrupted',
        reason: 'stop',
        detail: 'look_at interrupted (stop)',
      }),
    ).toBe('cam-1: look_at interrupted (stop).')
    expect(
      resultText('cam-1', 'look_at', { status: 'failed', reason: 'device', detail: 'motor stalled' }),
    ).toBe('cam-1: look_at failed (device): motor stalled.')
  })
})
