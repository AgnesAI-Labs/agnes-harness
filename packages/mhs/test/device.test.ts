import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallError, Device } from '../device/device.js'
import { South } from '../server/south.js'

let hub: South
let url: string
let port: number

beforeEach(async () => {
  hub = new South({ timing: { accept: 500, control: 1000 } })
  port = (await hub.listen(0)).port
  url = `ws://127.0.0.1:${port}`
})

afterEach(async () => {
  await hub.close()
})

const until = async (check: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

function makeDevice(id = 'dev-01') {
  const seen = { stops: 0, manual: [] as Record<string, number>[] }
  const dev = new Device({
    id,
    kind: 'robot',
    mobile: true,
    resources: { chassis: 'reject', speaker: 'queue' },
    manual: {
      axes: [{ id: 'vx', role: 'forward', unit: 'm/s', min: -0.5, max: 0.5 }],
      rate_hz: 10,
      deadman_s: 0.2,
    },
    state: {
      mode: { type: 'string', enum: ['idle', 'moving'] },
      battery: { type: 'integer', unit: '%', min: 0, max: 100, role: 'battery' },
      speed: { type: 'number', unit: 'm/s', min: 0.1, max: 1, writable: true },
    },
  })
  dev.update({ mode: 'idle', battery: 90, speed: 0.5 })
  dev.after = () => ({ odometry: { x: 0, y: 0, yaw: 0, v: 0, w: 0 } })
  dev.onStop = () => {
    seen.stops += 1
  }
  dev.onManual = (axes) => {
    seen.manual.push(axes)
  }
  const cam = dev.source('cam', 'image', 'front camera', { mime: 'image/jpeg', hz: 10 })
  dev.tool(
    {
      name: 'move',
      description: 'Drive straight.',
      timeout: 30,
      params: { x: { type: 'number', minimum: -2, maximum: 2 } },
      required: ['x'],
      uses: ['chassis'],
      motion: true,
      pausable: true,
    },
    async (call, { x }) => {
      for (let i = 0; i < 300; i++) {
        await call.checkpoint()
        call.progress({ done: i, total: 300 })
        await call.sleep(10)
      }
      return { detail: `moved ${x} m`, data: { x } }
    },
  )
  dev.tool(
    {
      name: 'say',
      description: 'Say something.',
      timeout: 10,
      params: { text: { type: 'string', maxLength: 5 } },
      uses: ['speaker'],
    },
    async (call, { text }) => {
      await call.sleep(50)
      return `said ${text ?? ''}`
    },
  )
  dev.tool({ name: 'jam', description: 'Fail on purpose.', timeout: 5 }, () => {
    throw new CallError('stuck', 'jammed')
  })
  return { dev, seen, cam }
}

async function connected(id = 'dev-01') {
  const made = makeDevice(id)
  const running = made.dev.run(url)
  await until(() => hub.devices().some((d) => d.id === id && d.available))
  return { ...made, running }
}

describe('Device (TypeScript)', () => {
  it('registers a description the hub accepts and runs calls to one result', async () => {
    const { dev } = await connected()
    const say = hub.call('dev-01', 'say', { text: 'hello' })
    expect(await say.reply).toEqual({ accepted: true })
    const outcome = await say.done
    expect(outcome).toMatchObject({ status: 'done', detail: 'said hello', after: { odometry: { x: 0 } } })
    expect(await hub.call('dev-01', 'jam', {}).done).toMatchObject({ status: 'error', reason: 'stuck' })
    dev.close()
  })

  it('rejects busy with the holder and queues on a queue resource', async () => {
    const { dev } = await connected()
    const first = hub.call('dev-01', 'move', { x: 1 })
    await first.reply
    const second = await hub.call('dev-01', 'move', { x: 1 }).done
    expect(second).toMatchObject({
      status: 'rejected',
      reason: 'busy',
      holder: { call: first.id, tool: 'move' },
    })
    const a = hub.call('dev-01', 'say', { text: 'a' })
    const b = hub.call('dev-01', 'say', { text: 'b' })
    expect(await b.reply).toEqual({ accepted: true })
    expect((await a.done).status).toBe('done')
    expect((await b.done).status).toBe('done')
    dev.close()
  })

  it('stop zeroes motion first and interrupts motion calls at once', async () => {
    const { dev, seen } = await connected()
    const move = hub.call('dev-01', 'move', { x: 1 })
    await move.reply
    expect(await hub.stop('dev-01')).toEqual({ stopped: [move.id] })
    expect(seen.stops).toBe(1)
    expect(await move.done).toMatchObject({ status: 'interrupted', reason: 'stop' })
    expect(await hub.cancel('dev-01', move.id)).toEqual({ cancelled: false })
    dev.close()
  })

  it('pauses, resumes and cancels', async () => {
    const { dev } = await connected()
    const states: string[] = []
    const move = hub.call('dev-01', 'move', { x: 1 }, { onProgress: (p) => p.state && states.push(p.state) })
    await move.reply
    expect(await hub.pause('dev-01', move.id)).toEqual({ paused: true })
    expect(await hub.resume('dev-01', move.id)).toEqual({ resumed: true })
    expect(await hub.cancel('dev-01', move.id)).toEqual({ cancelled: true })
    expect(await move.done).toMatchObject({ status: 'interrupted', reason: 'cancel' })
    expect(states).toEqual(['paused', 'running'])
    dev.close()
  })

  it('manual input interrupts motion, holds the chassis and the deadman stops it', async () => {
    const { dev, seen } = await connected()
    const move = hub.call('dev-01', 'move', { x: 1 })
    await move.reply
    hub.manual('dev-01', { vx: 3 })
    expect(await move.done).toMatchObject({ status: 'interrupted', reason: 'manual' })
    expect(seen.manual[0]).toEqual({ vx: 0.5 })
    expect(await hub.call('dev-01', 'move', { x: 1 }).done).toMatchObject({
      reason: 'busy',
      holder: { manual: true },
    })
    await until(() => seen.manual.at(-1)?.vx === 0)
    await new Promise((r) => setTimeout(r, 300))
    expect(await hub.call('dev-01', 'move', { x: 1 }).reply).toEqual({ accepted: true })
    dev.close()
  })

  it('streams sources as configured, with their binary payload', async () => {
    const { dev, cam } = await connected()
    expect(await hub.configure('dev-01', { cam: { on: true, hz: 50 } })).toEqual({
      sources: { cam: { on: true, hz: 10 } },
    })
    expect(cam.send({ w: 2, h: 2 }, new Uint8Array([0xff, 0xd8]))).toBe(true)
    await until(() => hub.latest('dev-01', 'cam') !== undefined)
    expect(hub.latest('dev-01', 'cam')?.binary).toEqual(Buffer.from([0xff, 0xd8]))
    await hub.configure('dev-01', { cam: { on: false } })
    expect(cam.send({ w: 2, h: 2 }, new Uint8Array([0]))).toBe(false)
    dev.close()
  })

  it('answers time and keyframe requests and keeps clips', async () => {
    const { dev } = await connected()
    const { rtt } = await hub.syncClock('dev-01')
    expect(rtt).toBeLessThan(0.5)
    expect(await hub.keyframe('dev-01', ['cam'])).toEqual({ sources: [] })
    hub.clip('dev-01', 'a1', 24000, 1, Buffer.from([1, 0]))
    await until(() => dev.clip('a1') !== undefined)
    expect(dev.clip('a1')).toMatchObject({ rate: 24000, channels: 1, pcm: new Uint8Array([1, 0]) })
    dev.close()
  })

  it('reports its state, applies settings and refuses the rest (10.1)', async () => {
    const { dev } = await connected()
    await until(() => hub.state('dev-01')?.values.battery === 90)
    expect(hub.state('dev-01')?.values).toEqual({
      problem: null,
      faults: [],
      mode: 'idle',
      battery: 90,
      speed: 0.5,
    })
    dev.update({ battery: 85 })
    dev.problem = 'left wheel slipping'
    await until(() => hub.state('dev-01')?.values.problem === 'left wheel slipping')
    expect(hub.state('dev-01')?.values.battery).toBe(85)
    expect(() => dev.update({ colour: 'red' })).toThrow('not a declared state field')
    const applied: [string, unknown][] = []
    dev.onSet = (name, value) => {
      applied.push([name, value])
    }
    const result = await hub.set('dev-01', { speed: 3 })
    expect(result).toMatchObject({ values: { speed: 1 }, notes: ['speed was 3, clamped to 1'] })
    expect(applied).toEqual([['speed', 1]])
    await until(() => hub.state('dev-01')?.values.speed === 1)
    expect(await hub.set('dev-01', { battery: 50, ghost: 1 })).toMatchObject({
      values: {},
      refused: { battery: 'not writable', ghost: 'not a state field' },
    })
    dev.close()
  })

  it('sends mhs/ping every 2 s, which the hub answers (CONN-9)', async () => {
    const pings: number[] = []
    await hub.close()
    hub = new South({
      timing: { accept: 500, control: 1000 },
      tap: (_, text) => {
        if (text.includes('"mhs/ping"')) pings.push(Date.now())
      },
    })
    await hub.listen(port)
    const { dev } = await connected()
    await until(() => pings.length >= 2, 5000)
    expect((pings[1] as number) - (pings[0] as number)).toBeGreaterThan(1500)
    expect(hub.devices()[0]?.available).toBe(true)
    dev.close()
  }, 8000)

  it('stops for good when replaced by another instance with its id (CONN-8)', async () => {
    const { running } = await connected()
    const other = makeDevice()
    void other.dev.run(url)
    await running
    other.dev.close()
  })

  it('stops and ends its calls when the hub goes away, then registers again (SAFE-2, CONN-7)', async () => {
    const { dev, seen } = await connected()
    const move = hub.call('dev-01', 'move', { x: 1 })
    await move.reply
    await hub.close()
    await until(() => seen.stops === 1)
    hub = new South()
    await hub.listen(port)
    await until(() => hub.devices().some((d) => d.id === 'dev-01'), 5000)
    dev.close()
  })
})
