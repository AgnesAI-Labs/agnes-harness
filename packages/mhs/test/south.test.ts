import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CLOSE, type Outcome, South } from '../server/south.js'
import { FakeDevice as Base, FakeNerve, type Msg, until } from './fakes.js'

/** The fake device of fakes.ts, registering ARM unless told otherwise. */
class FakeDevice extends Base {
  static override async open(url: string): Promise<FakeDevice> {
    const ws = new WebSocket(url, 'mhs.v1')
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return new FakeDevice(ws)
  }

  override register(description: Msg = ARM): Promise<Msg> {
    return super.register(description)
  }
}

const ARM = {
  protocol: 'mhs/v1',
  device: { id: 'arm-03', kind: 'arm' },
  resources: { arm: 'reject' },
  tools: [
    {
      name: 'move_joint',
      description: 'Move one joint to an angle.',
      inputSchema: {
        type: 'object',
        properties: {
          joint: { type: 'integer', minimum: 1, maximum: 6 },
          angle: { type: 'number', minimum: -170, maximum: 170 },
        },
        required: ['joint', 'angle'],
      },
      uses: ['arm'],
      motion: true,
      pausable: true,
      timeout: 0.2,
    },
  ],
}

let hub: South
let url: string

beforeEach(async () => {
  hub = new South({ timing: { accept: 200, grace: 100, control: 200 } })
  const address = await hub.listen(0)
  url = `ws://127.0.0.1:${address.port}/ws/mhs`
})

afterEach(async () => {
  await hub.close()
})

describe('registration', () => {
  it('accepts a valid description and lists the device', async () => {
    const online = new Promise((resolve) => hub.once('online', resolve))
    const device = await FakeDevice.open(url)
    const reply = await device.register()
    expect(reply.id).toBe('1')
    expect(reply.result).toMatchObject({ session: expect.any(String), hub: { name: expect.any(String) } })
    expect(typeof reply.result.time).toBe('number')
    // It has no sources or manual control, so it needs no Nerve channel (MHS 4.3).
    await online
    expect(hub.devices().map((d) => d.id)).toEqual(['arm-03'])
  })

  it.each([
    [
      'a first message that is not mhs/register',
      { jsonrpc: '2.0', id: '1', method: 'mhs/call', params: {} },
      -32600,
      CLOSE.badFirstMessage,
    ],
    [
      'another major version',
      { jsonrpc: '2.0', id: '1', method: 'mhs/register', params: { ...ARM, protocol: 'mhs/v2' } },
      -32001,
      CLOSE.badVersion,
    ],
    [
      'a description failing the schema',
      { jsonrpc: '2.0', id: '1', method: 'mhs/register', params: { protocol: 'mhs/v1' } },
      -32602,
      CLOSE.badFirstMessage,
    ],
    [
      'a fixed device without placement (REG-4)',
      { jsonrpc: '2.0', id: '1', method: 'mhs/register', params: { ...ARM, localization: 'fixed' } },
      -32602,
      CLOSE.badFirstMessage,
    ],
    [
      'a tool using an undeclared resource',
      { jsonrpc: '2.0', id: '1', method: 'mhs/register', params: { ...ARM, resources: {} } },
      -32602,
      CLOSE.badFirstMessage,
    ],
  ])('refuses %s', async (_, first, code, close) => {
    const device = await FakeDevice.open(url)
    device.send(first)
    expect((await device.next()).error.code).toBe(code)
    expect(await device.closed).toBe(close)
    expect(hub.devices()).toEqual([])
  })

  it('says why a fixed device without placement is refused', async () => {
    const device = await FakeDevice.open(url)
    const reply = await device.register({ ...ARM, localization: 'fixed' })
    expect(reply.error.message).toBe(
      'invalid device description: localization fixed needs placement {map, x, y, yaw} (REG-4)',
    )
  })

  it('replaces an older connection with the same device id (CONN-8)', async () => {
    const first = await FakeDevice.open(url)
    await first.register()
    const second = await FakeDevice.open(url)
    await second.register()
    expect(await first.closed).toBe(CLOSE.replaced)
    expect(hub.devices()).toHaveLength(1)
  })
})

describe('calls', () => {
  async function registered(): Promise<FakeDevice> {
    const device = await FakeDevice.open(url)
    await device.register()
    return device
  }

  it('clamps arguments, forwards progress and resolves with the result plus the hub notes', async () => {
    const device = await registered()
    const progress: Msg[] = []
    const call = hub.call(
      'arm-03',
      'move_joint',
      { joint: 2, angle: 200, extra: 1 },
      { onProgress: (p) => progress.push(p) },
    )
    const request = await device.next()
    expect(request).toMatchObject({
      method: 'mhs/call',
      id: call.id,
      params: { name: 'move_joint', arguments: { joint: 2, angle: 170 } },
    })
    device.reply(request.id, { accepted: true })
    expect(await call.reply).toEqual({ accepted: true })
    device.notify('mhs/progress', { call: call.id, done: 20, total: 170 })
    device.notify('mhs/result', {
      call: call.id,
      status: 'done',
      detail: 'joint 2 at 170 degrees',
      notes: ['slow'],
    })
    const outcome = await call.done
    expect(outcome).toMatchObject({ status: 'done', detail: 'joint 2 at 170 degrees' })
    expect((outcome as { notes: string[] }).notes).toEqual([
      'dropped unknown parameter extra',
      'angle was 200, clamped to 170',
      'slow',
    ])
    expect(progress).toEqual([{ call: call.id, done: 20, total: 170 }])
  })

  it.each([
    ['an unknown device', 'nobody', 'move_joint', { joint: 1, angle: 0 }, 'offline'],
    ['an unknown tool', 'arm-03', 'dance', {}, 'invalid'],
    ['a missing required parameter', 'arm-03', 'move_joint', { angle: 0 }, 'invalid'],
    ['a wrong type', 'arm-03', 'move_joint', { joint: 1.5, angle: 0 }, 'invalid'],
  ])('rejects %s without asking the device', async (_, device, tool, args, reason) => {
    const fake = await registered()
    const call = hub.call(device, tool, args)
    expect(await call.done).toMatchObject({ status: 'rejected', reason })
    expect(fake.inbox).toEqual([])
  })

  it('passes a busy rejection and its holder through', async () => {
    const device = await registered()
    const call = hub.call('arm-03', 'move_joint', { joint: 1, angle: 0 })
    const request = await device.next()
    const holder = { call: 'c0', tool: 'move_joint' }
    device.reply(request.id, { accepted: false, status: 'rejected', reason: 'busy', holder })
    expect(await call.done).toMatchObject({ status: 'rejected', reason: 'busy', holder })
  })

  it('stops the device and records a timeout when a call is not accepted in time (CALL-2)', async () => {
    const device = await registered()
    const call = hub.call('arm-03', 'move_joint', { joint: 1, angle: 0 })
    await device.next()
    expect(await device.next()).toMatchObject({ method: 'mhs/stop' })
    expect(await call.done).toMatchObject({ status: 'error', reason: 'timeout' })
  })

  it('cancels, then stops, a call that outlives its timeout (spec 11)', async () => {
    const device = await registered()
    const call = hub.call('arm-03', 'move_joint', { joint: 1, angle: 0 })
    device.reply((await device.next()).id, { accepted: true })
    expect(await call.done).toMatchObject({ status: 'error', reason: 'timeout' })
    const cancel = await device.next()
    expect(cancel).toMatchObject({ method: 'mhs/cancel', params: { call: call.id } })
    device.reply(cancel.id, { cancelled: true })
    expect(await device.next()).toMatchObject({ method: 'mhs/stop' })
  })

  it('interrupts running calls when the command channel is lost (spec 17.2)', async () => {
    const device = await registered()
    const call = hub.call('arm-03', 'move_joint', { joint: 1, angle: 0 })
    device.reply((await device.next()).id, { accepted: true })
    await call.reply
    device.ws.close()
    const outcome: Outcome = await call.done
    expect(outcome).toMatchObject({ status: 'interrupted', reason: 'disconnect' })
    await until(() => hub.devices().length === 0)
  })
})

describe('control', () => {
  it('sends stop and returns the interrupted calls', async () => {
    const device = await FakeDevice.open(url)
    await device.register()
    const stopped = hub.stop('arm-03')
    const request = await device.next()
    expect(request).toMatchObject({ method: 'mhs/stop', params: {} })
    device.reply(request.id, { stopped: ['c1'] })
    expect(await stopped).toEqual({ stopped: ['c1'] })
  })

  it('closes the command channel of a device that does not answer stop (spec 11)', async () => {
    const device = await FakeDevice.open(url)
    await device.register()
    await expect(hub.stop('arm-03')).rejects.toThrow()
    expect(await device.closed).toBe(1011)
  })

  it('treats a pause without a reply as not paused', async () => {
    const device = await FakeDevice.open(url)
    await device.register()
    expect(await hub.pause('arm-03', 'c1')).toEqual({ paused: false })
    expect(device.ws.readyState).toBe(WebSocket.OPEN)
  })
})

const CAMERA = {
  protocol: 'mhs/v1',
  device: { id: 'cam-01', kind: 'camera' },
  sources: [
    { id: 'cam', kind: 'image', mime: 'image/jpeg', description: 'front camera' },
    {
      id: 'battery',
      kind: 'values',
      description: 'battery',
      fields: { percent: { type: 'number', unit: '%' } },
    },
  ],
  manual: {
    axes: [{ id: 'pan', role: 'yaw', unit: 'deg/s', min: -30, max: 30 }],
    rate_hz: 10,
    deadman_s: 0.5,
  },
}

describe('Nerve', () => {
  async function camera(): Promise<{ device: FakeDevice; nerve: FakeNerve }> {
    const device = await FakeDevice.open(url)
    await device.register(CAMERA)
    const online = new Promise((resolve) => hub.once('online', resolve))
    const nerve = await FakeNerve.open(url)
    await online
    return { device, nerve }
  }

  it('makes a device with sources available only once its Nerve channel is open (4.3)', async () => {
    const device = await FakeDevice.open(url)
    await device.register(CAMERA)
    expect(hub.devices()[0]?.available).toBe(false)
    const online = new Promise((resolve) => hub.once('online', resolve))
    const nerve = await FakeNerve.open(url)
    await online
    expect(hub.devices()[0]?.available).toBe(true)
    const offline = new Promise((resolve) => hub.once('offline', (_, reason) => resolve(reason)))
    nerve.ws.close()
    expect(await offline).toBe('Nerve channel closed')
  })

  it('refuses a Nerve channel whose first message is not hello (CONN-4)', async () => {
    const nerve = await FakeNerve.open(url, null)
    nerve.send({ type: 'status', busy: {}, problem: null })
    expect(await nerve.closed).toBe(CLOSE.badFirstMessage)
  })

  it('delivers data with its binary frame, checks payloads by kind and keeps the latest', async () => {
    const { nerve } = await camera()
    const seen: [Msg, Buffer | undefined][] = []
    hub.on('data', (_, msg, binary) => seen.push([msg, binary]))
    nerve.send({ type: 'data', source: 'cam', seq: 0, t: 1, data: { w: 2, h: 2 }, bin: true })
    nerve.send(Buffer.from([0xff, 0xd8]))
    nerve.send({ type: 'data', source: 'battery', seq: 0, t: 1, data: { percent: 'full' } })
    nerve.send({ type: 'data', source: 'lidar', seq: 0, t: 1, data: {} })
    nerve.send({ type: 'data', source: 'battery', seq: 1, t: 2, data: { percent: 80 } })
    await until(() => seen.length === 2)
    expect(seen[0]?.[0]).toMatchObject({ source: 'cam' })
    expect(seen[0]?.[1]).toEqual(Buffer.from([0xff, 0xd8]))
    expect(seen[1]?.[0]).toMatchObject({ source: 'battery', data: { percent: 80 } })
    expect(hub.latest('cam-01', 'battery')?.msg.seq).toBe(1)
  })

  it('sends manual input and audio clips to the device', async () => {
    const { nerve } = await camera()
    expect(hub.manual('cam-01', { pan: 10 })).toBe(true)
    expect(hub.clip('cam-01', 'a1', 24000, 1, Buffer.from([1, 0]))).toBe(true)
    await until(() => nerve.inbox.length === 3)
    expect(nerve.inbox).toEqual([
      { type: 'manual', axes: { pan: 10 } },
      { type: 'clip', id: 'a1', rate: 24000, channels: 1 },
      Buffer.from([1, 0]),
    ])
  })

  it('configures sources, asks for keyframes and measures the device clock', async () => {
    const { device } = await camera()
    const configured = hub.configure('cam-01', { cam: { on: true, hz: 5 } })
    const request = await device.next()
    expect(request).toMatchObject({
      method: 'mhs/configure',
      params: { sources: { cam: { on: true, hz: 5 } } },
    })
    device.reply(request.id, { sources: { cam: { on: true, hz: 5 } } })
    expect(await configured).toEqual({ sources: { cam: { on: true, hz: 5 } } })
    const keyframe = hub.keyframe('cam-01', ['cam'])
    const k = await device.next()
    device.reply(k.id, { sources: ['cam'] })
    expect(await keyframe).toEqual({ sources: ['cam'] })
    const { offset } = await hub.syncClock('cam-01')
    expect(offset).toBeGreaterThan(99)
    expect(offset).toBeLessThan(101)
    expect(hub.hubTime('cam-01', 1100)).toBeCloseTo(1000, 0)
  })
})

const LAMP = {
  protocol: 'mhs/v1',
  device: { id: 'lamp-01', kind: 'light' },
  state: {
    mode: { type: 'string', enum: ['off', 'on'] },
    temperature: { type: 'number', unit: '°C', alert: { warn: 60, bad: 80 } },
    brightness: { type: 'integer', min: 0, max: 100, writable: true },
  },
}

describe('state (MHS 10.1)', () => {
  async function lamp(): Promise<FakeDevice> {
    const device = await FakeDevice.open(url)
    await device.register(LAMP)
    return device
  }

  it('keeps the state the device reports, checks it against the declaration, and raises alerts', async () => {
    const device = await lamp()
    const alerts: unknown[] = []
    hub.on('alert', (...a) => alerts.push(a))
    device.notify('mhs/state', {
      t: 1,
      values: { mode: 'on', temperature: 40, brightness: 50, problem: null, faults: [] },
    })
    device.notify('mhs/state', { t: 2, values: { temperature: 65, mode: 'dim', ghost: 1 } })
    await until(() => hub.state('lamp-01')?.values.temperature === 65)
    expect(hub.state('lamp-01')?.values).toEqual({
      mode: 'on',
      temperature: 65,
      brightness: 50,
      problem: null,
      faults: [],
    })
    expect(alerts).toEqual([['lamp-01', 'temperature', 'warn', 65]])
    device.ws.close()
    await until(() => hub.devices().length === 0)
    expect(hub.state('lamp-01')?.values.mode).toBe('on')
  })

  it('sets only writable fields of the right type and returns what the device applied', async () => {
    const device = await lamp()
    const result = hub.set('lamp-01', { brightness: 120, mode: 'off', ghost: 1 })
    const request = await device.next()
    expect(request).toMatchObject({ method: 'mhs/set', params: { values: { brightness: 120 } } })
    device.reply(request.id, { values: { brightness: 100 }, notes: ['brightness was 120, clamped to 100'] })
    expect(await result).toEqual({
      values: { brightness: 100 },
      notes: ['brightness was 120, clamped to 100'],
      refused: { mode: 'not writable', ghost: 'not a state field' },
    })
    expect(await hub.set('lamp-01', { brightness: 'max' })).toEqual({
      values: {},
      refused: { brightness: 'brightness must be integer' },
    })
  })
})
