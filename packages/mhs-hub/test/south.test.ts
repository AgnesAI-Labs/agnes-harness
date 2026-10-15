import { connectDevice, Device } from '@agnes/mhs-device'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { Hub, South } from '../src/index.js'
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
      await hub.call('rover', 'move', { x: 0.5 }, invocation('network'))
      await vi.waitFor(async () =>
        expect((await hub.journal.read('network'))?.outcome).toMatchObject({ status: 'done', data: 0.5 }),
      )
      expect((await hub.stop('rover')).state).toBe('settled')
    } finally {
      controller.abort()
      await running
      await south.close()
    }
    expect((await hub.list())[0]?.available).toBe(false)
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
