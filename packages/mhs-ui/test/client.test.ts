import { afterEach, describe, expect, it, vi } from 'vitest'
import { MhsClient, receiptMessage } from '../src/client.js'
import { ManualController } from '../src/manual.js'
import { sampleFrom } from '../src/media.js'
import { activityFrom, devicesFrom, TOOL_NAMES, toolsFrom } from '../src/model.js'
import { profileServices } from '../src/profile-services.js'
import { MhsStore, usedDeviceIds } from '../src/store.js'
import { deferred, device, fake, Stream } from './fixtures.js'

afterEach(() => vi.useRealTimers())
describe('owner-bound MHS browser data', () => {
  it('clears session devices synchronously and discards an old projection after a switch', async () => {
    vi.useFakeTimers()
    const f = fake(),
      client = new MhsClient(f.ports),
      store = new MhsStore(client),
      stop = store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.read().status).toBe('ready')
    f.setNodes([
      {
        kind: 'tool',
        name: 'read_device',
        toolUseId: 'a',
        status: 'completed',
        argsPreview: '{"device":"rover-01"}',
        resultPreview: '{}',
        seq: 4,
      },
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect([...usedDeviceIds(store.read().calls)]).toEqual(['rover-01'])
    const pending = deferred<unknown>()
    f.ports.session.projection.read = () => pending.promise
    f.setNodes([])
    f.setSession('session-b')
    expect(store.read().calls).toEqual([])
    expect(store.read().sessionId).toBe('session-b')
    f.setSession(undefined)
    pending.resolve({
      status: 'available',
      value: { nodes: [{ kind: 'tool', name: 'call_device', args: { device: 'wrong' } }] },
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.read().calls).toEqual([])
    stop()
    expect(store.read()).toMatchObject({ status: 'disabled', devices: [], calls: [] })
    expect(f.stream.closed).toBe(true)
    expect(f.sessionListeners.size).toBe(0)
    expect(f.projectionListeners.size).toBe(0)
  })
  it('does not turn a malformed/offline projection or listing into an online used device', () => {
    expect(() => devicesFrom([{ id: 'x' }])).toThrow()
    expect(devicesFrom([{ ...device(), online: false, available: false }])[0]?.available).toBe(false)
    const calls = toolsFrom(
      TOOL_NAMES.map((name, i) => ({
        kind: 'tool',
        name,
        toolUseId: String(i),
        argsPreview: name === 'list_devices' ? '{}' : '{"device":"rover-01"}',
        resultPreview: '{"id":"not-a-device"}',
        status: 'failed',
        seq: i + 1,
      })),
    )
    expect(calls).toHaveLength(7)
    expect(calls[0]?.callSeq).toBe(7)
    expect([...usedDeviceIds(calls)]).toEqual(['rover-01'])
    expect(activityFrom({ events: [], earliest: 123, nextCursor: 'next' })).toEqual({
      events: [],
      earliest: 123,
      nextCursor: 'next',
    })
  })
  it('assigns a fresh operation id per user request, preserves native refusal/unknown and never retries effects', async () => {
    const f = fake(),
      client = new MhsClient(f.ports)
    f.receipt = { state: 'approval-required', operationId: 'operation', decisionId: 'decision' }
    expect(await client.effect('call', { device: 'rover-01', tool: 'go', args: {} })).toMatchObject({
      state: 'approval-required',
    })
    await client.effect('stop', {})
    expect(f.effects[0]?.operationId).not.toBe(f.effects[1]?.operationId)
    expect(f.effects[0]?.input).toEqual({ device: 'rover-01', tool: 'go', args: {} })
    expect(receiptMessage({ state: 'refused', operationId: 'x', code: 'expired' })).toBe('expired')
    expect(
      receiptMessage({
        state: 'completed',
        operationId: 'x',
        output: { state: 'unknown', devices: { 'rover-01': 'unknown' } },
      }),
    ).toBe('unknown')
    client.dispose()
    await expect(client.effect('stop', {})).rejects.toThrow()
  })
  it('reads native operation receipts through the original declared service without repeating dispatch', async () => {
    const reads: string[][] = []
    const services = profileServices({
      async query() {
        return []
      },
      async effect(_name, _input, { operationId }) {
        return { state: 'approval-required', operationId, decision: { id: 'native' } }
      },
      async readOperation(name, id) {
        reads.push([name, id])
        return { state: 'refused', operationId: id, code: 'APPROVAL_REFUSED' }
      },
    })
    expect(await services.effect('mhs.call', { device: 'rover-01' }, { operationId: 'once' })).toMatchObject({
      state: 'approval-required',
      operationId: 'once',
    })
    expect(await services.readOperation('once')).toMatchObject({ state: 'refused', code: 'APPROVAL_REFUSED' })
    expect(reads).toEqual([['mhs.call', 'once']])
    await expect(services.readOperation('other')).rejects.toThrow('unknown-operation-service')
  })
  it('closes a stream which finishes opening after disposal and rejects invalid binary framing', async () => {
    const f = fake(),
      pending = deferred<Stream>()
    f.ports.streams.open = () => pending.promise
    const client = new MhsClient(f.ports),
      opened = client.stream('media', { device: 'rover-01', source: 'front' }, () => {})
    client.dispose()
    const stream = new Stream()
    pending.resolve(stream)
    await expect(opened).rejects.toThrow('Disposed')
    expect(stream.closed).toBe(true)
    expect(() => sampleFrom(new Uint8Array([0, 0, 255, 255]))).toThrow('invalid-media-frame')
  })
})
describe('manual interaction deadman', () => {
  it('sends only declared bounded axes, zeros on release, stops independently, and does not replay expired controls', async () => {
    vi.useFakeTimers()
    let now = 1000
    const stream = new Stream(),
      stops: string[] = []
    const controller = new ManualController(
      stream,
      [
        { id: 'vx', min: -1, max: 2 },
        { id: 'pitch', min: -30, max: 30 },
      ],
      2000,
      async () => {
        stops.push('stop')
      },
      () => now,
    )
    controller.set('vx', 4)
    controller.set('unknown', 1)
    controller.set('pitch', -1)
    await vi.advanceTimersByTimeAsync(40)
    expect(stream.sent.at(-1)).toEqual({ type: 'manual', axes: { vx: 2, pitch: -30 } })
    controller.zero()
    expect(stream.sent.at(-1)).toEqual({ type: 'manual', axes: { vx: 0, pitch: 0 } })
    now = 2001
    await vi.advanceTimersByTimeAsync(40)
    expect(stops).toEqual(['stop'])
    expect(stream.closed).toBe(true)
    const count = stream.sent.length
    controller.set('vx', 1)
    await controller.release()
    expect(stream.sent).toHaveLength(count)
    expect(
      () =>
        new ManualController(
          new Stream(),
          [],
          1,
          async () => {},
          () => 2,
        ),
    ).toThrow('expired-lease')
  })
})
