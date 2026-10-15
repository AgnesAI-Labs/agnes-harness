import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { description } from '../../mhs-hub/test/fixtures.js'
import { Device, prepareArguments, validateRegistration } from '../src/index.js'

afterEach(() => vi.useRealTimers())
describe('device-local boundaries', () => {
  it('validates descriptions and the physical parameter subset before accepting tools', () => {
    expect(validateRegistration(description).device.id).toBe('rover')
    for (const bad of [
      { ...description, protocol: 'mhs/v2' },
      { ...description, resources: {} },
      { ...description, tools: [...(description.tools ?? []), ...(description.tools ?? [])] },
      { ...description, manual: { ...description.manual, deadman_s: 3 } },
      {
        ...description,
        tools: [{ ...description.tools?.[0], inputSchema: { type: 'object', $ref: 'http://invalid' } }],
      },
      { ...description, localization: 'fixed' },
    ])
      expect(() => validateRegistration(bad)).toThrow()
    expect(
      prepareArguments(
        { type: 'object', properties: { n: { type: 'number', minimum: -2, maximum: 2 } } },
        { n: 9, hidden: true },
      ),
    ).toEqual({ n: 2 })
    expect(() => prepareArguments({ type: 'number' }, NaN)).toThrow()
    const cases = JSON.parse(readFileSync(new URL('./arguments.json', import.meta.url), 'utf8')) as {
      schema: Record<string, unknown>
      value: unknown
      expected?: unknown
      error?: boolean
    }[]
    for (const row of cases) {
      if (row.error) expect(() => prepareArguments(row.schema, row.value)).toThrow()
      else expect(prepareArguments(row.schema, row.value)).toEqual(row.expected)
    }
  })
  it('requires local safety, reserves resources before awaiting, and settles interrupted work once', async () => {
    const unsafe = new Device(description).tool('move', async () => null)
    expect(unsafe.call('u', 'move', { x: 1 })).toMatchObject({ accepted: false, reason: 'unsafe' })
    const stopped: string[] = []
    const device = new Device(description, {
      arm() {},
      async stop(reason) {
        stopped.push(reason)
      },
    })
    device.tool(
      'move',
      async (_args, call) =>
        new Promise((_resolve, reject) =>
          call.signal.addEventListener('abort', () => reject(new Error('interrupted'))),
        ),
    )
    const first = device.call('a', 'move', { x: 99 })
    expect(first.accepted).toBe(true)
    expect(device.call('b', 'move', { x: 0 })).toMatchObject({ accepted: false, reason: 'busy' })
    await device.stop()
    expect(await first.result).toMatchObject({ status: 'interrupted', reason: 'stop' })
    expect(stopped).toContain('stop')
    device.receiveClip('audio', 24000, 1, new Uint8Array([0, 0]))
    expect(device.clip('audio')?.pcm).toEqual(new Uint8Array([0, 0]))
    device.update({ faults: ['x_fault'] })
    expect(device.call('faulted', 'move', { x: 1 })).toMatchObject({ accepted: false, reason: 'unsafe' })
    expect(device.set({ lamp: true, battery: 1 })).toEqual({ values: { lamp: true }, refused: ['battery'] })
  })
  it('reports paused only after reaching rest and reports running after resume', async () => {
    vi.useFakeTimers()
    let rested = false,
      reach: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      reach = resolve
    })
    const device = new Device(
      { ...description, tools: (description.tools ?? []).map((tool) => ({ ...tool, pausable: true })) },
      {
        arm() {},
        async stop() {
          rested = true
        },
      },
    )
    const progress: { data: unknown; rested: boolean }[] = []
    device.onProgress = (_id, data) => {
      progress.push({ data, rested })
    }
    device.tool('move', async (_args, call) => {
      await gate
      await call.checkpoint()
      return null
    })
    const result = device.call('paused', 'move', { x: 1 })
    const paused = device.pause('paused')
    reach()
    await paused
    expect(progress).toEqual([{ data: { state: 'paused' }, rested: true }])
    device.resume('paused')
    expect(await result.result).toMatchObject({ status: 'done' })
    expect(progress.at(-1)?.data).toEqual({ state: 'running' })
  })
  it('clamps manual axes, zeros omitted axes, and expires local control within two seconds', async () => {
    vi.useFakeTimers()
    const stopped: string[] = []
    const seen: Record<string, number>[] = []
    const device = new Device(description, {
      arm() {},
      async stop(reason) {
        stopped.push(reason)
      },
    })
    device.onManual = async (axes) => {
      seen.push(axes)
    }
    await device.manual({ vx: 99 })
    expect(seen.at(-1)).toEqual({ vx: 1 })
    await vi.advanceTimersByTimeAsync(201)
    expect(stopped).toContain('deadman')
    expect(seen.at(-1)).toEqual({ vx: 0 })
    await device.configure({ front: { on: false } })
    device.onObservation = () => true
    expect(device.publish('front', { w: 1, h: 1 }, new Uint8Array([1]), 'image/png')).toBe(false)
    await device.disconnect()
    await expect(device.manual({ vx: 1 })).rejects.toThrow('unsafe')
  })
})
