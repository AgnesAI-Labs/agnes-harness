import { createHash } from 'node:crypto'
import { connectDevice, Device } from '@agnes/mhs-device'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { type DeviceLink, Hub, North, South } from '../src/index.js'
import { authority, description, invocation, MemoryStore } from './fixtures.js'

// Real sockets in this process; no daemon, worker, CLI, hardware or external account is started.
describe('device dual-channel transport', () => {
  it('registers a synthetic SDK device, exchanges commands and handles disconnect without replay', async () => {
    const hub = new Hub({
      store: new MemoryStore(),
      authority,
      wakes: {
        async enqueue() {
          return { wakeId: 'w', state: 'queued' }
        },
      },
    })
    const south = new South(hub)
    const address = await south.listen(0)
    const controller = new AbortController()
    const device = new Device(description, { arm() {}, async stop() {} }).tool('move', async (args) => args.x)
    device.onManual = async () => {}
    device.update({ battery: 90, lamp: false })
    const running = connectDevice(device, `ws://${address.host}:${address.port}`, controller.signal)
    try {
      await vi.waitFor(async () => expect((await hub.list())[0]?.available).toBe(true), { timeout: 3000 })
      const reading = hub.read('rover', ['front'])
      await vi.waitFor(() =>
        expect(device.publish('front', { w: 1, h: 1 }, new Uint8Array([1, 2]), 'image/png')).toBe(true),
      )
      expect((await reading).items[0]?.bytes).toEqual(new Uint8Array([1, 2]))
      await hub.call('rover', 'move', { x: 0.5 }, invocation('network'))
      await vi.waitFor(async () =>
        expect((await hub.journal.read('network'))?.outcome).toMatchObject({ status: 'done', data: 0.5 }),
      )
      const pcm = new Uint8Array([1, 0, 2, 0])
      await hub.clipLease(
        'rover',
        {
          id: 'voice',
          rate: 24000,
          channels: 1,
          bytes: pcm.length,
          sha256: createHash('sha256').update(pcm).digest('hex'),
        },
        invocation('voice'),
      )
      await hub.sendClip('rover', 'voice', pcm)
      expect(device.clip('voice')?.pcm).toEqual(pcm)
      expect((await hub.stop('rover')).state).toBe('settled')
    } finally {
      controller.abort()
      await running
      await south.close()
    }
    expect((await hub.list())[0]?.available).toBe(false)
  })
  it('pauses only after SDK rest, then resumes and cancels the same real-socket job', async () => {
    const hub = new Hub({
      store: new MemoryStore(),
      authority,
      wakes: {
        async enqueue() {
          return { wakeId: 'w', state: 'queued' }
        },
      },
    })
    const south = new South(hub),
      address = await south.listen(0)
    const controller = new AbortController()
    let checkpoint!: () => void, rest!: () => void
    const gate = new Promise<void>((r) => {
      checkpoint = r
    })
    const resting = new Promise<void>((r) => {
      rest = r
    })
    const device = new Device(
      { ...description, tools: description.tools!.map((t) => ({ ...t, pausable: true })) },
      { arm() {}, async stop() {} },
    ).tool('move', async (_args, call) => {
      await gate
      await call.checkpoint(async () => resting)
      await new Promise<void>((_r, reject) =>
        call.signal.addEventListener('abort', () => reject(new Error('cancel'))),
      )
      return null
    })
    device.onManual = async () => {}
    device.update({ battery: 90, lamp: false })
    const running = connectDevice(device, `ws://${address.host}:${address.port}`, controller.signal)
    const north = new North(hub)
    try {
      await vi.waitFor(async () => expect((await hub.list())[0]?.available).toBe(true))
      await north.effect('call', { device: 'rover', tool: 'move', args: { x: 1 } }, invocation('job'))
      await expect(
        north.effect(
          'pause',
          { device: 'rover', params: { call: 'job' } },
          { ...invocation('denied'), context: {} },
        ),
      ).rejects.toThrow()
      let entered!: () => void
      const pauseEntered = new Promise<void>((r) => {
        entered = r
      })
      const pause = device.pause.bind(device)
      device.pause = async (id) => {
        const result = pause(id)
        checkpoint()
        entered()
        return result
      }
      const paused = north.effect('pause', { device: 'rover', params: { call: 'job' } }, invocation('pause'))
      await pauseEntered
      expect((await hub.journal.read('job'))?.phase).not.toBe('paused')
      rest()
      expect(await paused).toMatchObject({ outcome: { status: 'done' } })
      expect((await hub.journal.read('job'))?.phase).toBe('paused')
      await north.effect('resume', { device: 'rover', params: { call: 'job' } }, invocation('resume'))
      expect((await hub.journal.read('job'))?.phase).toBe('running')
      await north.effect('cancel', { device: 'rover', params: { call: 'job' } }, invocation('cancel'))
      await vi.waitFor(async () =>
        expect((await hub.journal.read('job'))?.outcome?.status).toBe('interrupted'),
      )
      expect((await hub.stop()).state).toBe('settled')
    } finally {
      checkpoint()
      rest()
      controller.abort()
      await running
      await south.close()
    }
  })
  it('refuses browser-origin bypass and duplicate or malformed registration before any device action', async () => {
    const hub = new Hub({
      store: new MemoryStore(),
      authority,
      wakes: {
        async enqueue() {
          return { wakeId: 'w', state: 'queued' }
        },
      },
    })
    const south = new South(hub)
    const address = await south.listen(0)
    const url = `ws://127.0.0.1:${address.port}/ws/mhs`
    try {
      const refused = new WebSocket(url, { origin: 'http://untrusted.invalid' })
      await new Promise<void>((resolve) => refused.on('error', () => resolve()))
      const bad = new WebSocket(url, 'mhs.v1')
      await new Promise<void>((resolve) => bad.on('open', () => resolve()))
      bad.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'r',
          method: 'mhs/register',
          params: { ...description, resources: {} },
        }),
      )
      await new Promise<void>((resolve) =>
        bad.on('close', (code) => {
          expect(code).toBe(4002)
          resolve()
        }),
      )
      expect(await hub.list()).toEqual([])
    } finally {
      await south.close()
    }
  })
})

describe('South failure deadlines with a real socket and virtual clock', () => {
  it.each(['accept', 'execution', 'pause', 'stop'] as const)(
    'bounds %s acknowledgement and parks without replay',
    async (mode) => {
      let online!: (link: DeviceLink) => void
      const registered = new Promise<DeviceLink>((r) => {
        online = r
      })
      const south = new South({ online, offline() {}, observation() {}, state() {}, progress() {} })
      const address = await south.listen(0)
      const peer = new WebSocket(`ws://127.0.0.1:${address.port}/ws/mhs`, 'mhs.v1')
      const pending = new Map<string, (message: Record<string, unknown>) => void>()
      const messages: Record<string, unknown>[] = []
      peer.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as Record<string, unknown>
        if (!message.method) return
        messages.push(message)
        pending.get(String(message.method))?.(message)
        pending.delete(String(message.method))
      })
      const next = (method: string) => {
        const existing = messages.find((m) => m.method === method)
        return existing
          ? Promise.resolve(existing)
          : new Promise<Record<string, unknown>>((r) => pending.set(method, r))
      }
      const reply = (message: Record<string, unknown>, result: unknown = {}) =>
        peer.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      try {
        await new Promise<void>((r) => peer.once('open', r))
        peer.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'register',
            method: 'mhs/register',
            params: {
              protocol: 'mhs/v1',
              device: { id: 'silent', kind: 'sensor' },
              tools: [
                {
                  name: 'wait',
                  description: 'Wait',
                  timeout: 0.1,
                  pausable: true,
                  inputSchema: { type: 'object' },
                },
              ],
            },
          }),
        )
        const link = await registered
        vi.useFakeTimers()
        if (mode === 'accept') {
          const calling = link.call('job', 'wait', {})
          const rejected = expect(calling).rejects.toThrow('timeout')
          await next('mhs/call')
          await vi.advanceTimersByTimeAsync(2001)
          await rejected
        } else if (mode === 'execution') {
          const calling = link.call('job', 'wait', {})
          reply(await next('mhs/call'), { accepted: true })
          const accepted = await calling
          await vi.advanceTimersByTimeAsync(5101)
          expect(await accepted.result).toMatchObject({ status: 'unknown', reason: 'timeout' })
        } else {
          const request = link.request(`mhs/${mode}`, mode === 'pause' ? { call: 'job' } : {})
          const rejected = expect(request).rejects.toThrow('timeout')
          await next(`mhs/${mode}`)
          await vi.advanceTimersByTimeAsync(2001)
          await rejected
        }
        if (mode !== 'stop') {
          reply(await next('mhs/cancel'))
          const stop = await next('mhs/stop')
          expect(messages.findIndex((m) => m.method === 'mhs/cancel')).toBeLessThan(
            messages.findIndex((m) => m.method === 'mhs/stop'),
          )
          if (mode === 'pause') {
            const closed = new Promise<void>((r) => peer.once('close', () => r()))
            await vi.advanceTimersByTimeAsync(1501)
            await closed
            expect(link.available).toBe(false)
          } else reply(stop)
        } else {
          await new Promise<void>((r) => (peer.readyState === 3 ? r() : peer.once('close', () => r())))
          expect(link.available).toBe(false)
        }
      } finally {
        vi.useRealTimers()
        peer.terminate()
        await south.close()
      }
    },
  )
})
