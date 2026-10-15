import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { Device } from '@agnes/mhs-device'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { connectExternalHub, externalHubAddress, Hub, serveExternalHubPeer } from '../src/index.js'
import { authority, description, invocation, MemoryStore } from './fixtures.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
it.each([
  'ws://192.0.2.1/mhs-peer/v1',
  'wss://example.com/mhs-peer/v1',
  'wss://127.0.0.1/private',
  'wss://user:password@127.0.0.1/mhs-peer/v1',
  'wss://127.0.0.1/mhs-peer/v1?target=x',
])('refuses unreviewed or ambiguous external peer address %s', (address) => {
  expect(() => externalHubAddress({ address, allowlist: [address] })).toThrow()
})
it('imports an exclusive remote fleet through local admission, stops on revoke and isolates other profiles', async () => {
  const axes: Record<string, number>[] = []
  let finishMove = false
  const registration = {
    ...description,
    tools: description.tools?.map((tool) => ({ ...tool, pausable: true })),
  }
  const device = new Device(registration, { arm() {}, async stop() {} }),
    movements: number[] = []
  device.onManual = async (value) => {
    axes.push(value)
  }
  device.update({ battery: 90 })
  device.tool('move', async (args, context) => {
    movements.push(Number(args.x))
    while (args.x === 2 && !finishMove) {
      await context.checkpoint()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return { moved: args.x! }
  })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1 << 20 })
  await once(server, 'listening')
  const life = new AbortController(),
    peerLife = new AbortController()
  cleanups.push(async () => {
    peerLife.abort()
    life.abort()
    for (const s of server.clients) s.terminate()
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  })
  server.on('connection', (socket) => serveExternalHubPeer(socket, [device], peerLife.signal))
  const addressInfo = server.address()
  if (!addressInfo || typeof addressInfo === 'string') throw new Error('port')
  const address = `ws://127.0.0.1:${addressInfo.port}/mhs-peer/v1`
  await expect(connectExternalHub({} as Hub, { address, allowlist: [] }, life.signal)).rejects.toThrow(
    'external-hub-address-denied',
  )
  const hub = new Hub({
    store: new MemoryStore(),
    authority,
    wakes: { enqueue: async () => ({ wakeId: 'w', state: 'queued' }) },
  })
  await hub.recover()
  const remote = await connectExternalHub(hub, { address, allowlist: [address] }, life.signal)
  expect(remote.connected).toBe(true)
  expect((await hub.list())[0]).toMatchObject({ id: 'rover', available: true, state: { battery: 90 } })
  const other = new Hub({
    store: new MemoryStore(),
    authority,
    wakes: { enqueue: async () => ({ wakeId: 'w', state: 'queued' }) },
  })
  expect(await other.list()).toEqual([])
  await expect(
    hub.call('rover', 'move', { x: 1 }, { ...invocation('bad'), context: { approved: true } }),
  ).rejects.toThrow()
  expect(movements).toEqual([])
  await hub.call('rover', 'move', { x: 1 }, invocation('good'))
  await vi.waitFor(async () =>
    expect((await hub.journal.read('good'))?.outcome).toMatchObject({ status: 'done' }),
  )
  expect(movements).toEqual([1])
  const pcm = new Uint8Array(4096).fill(42)
  await expect(hub.clipChunk('rover', 'unapproved', pcm.subarray(0, 2048))).rejects.toThrow(
    'clip-grant-required',
  )
  await hub.clipLease(
    'rover',
    {
      id: 'remote-clip',
      rate: 16000,
      channels: 1,
      bytes: pcm.length,
      sha256: createHash('sha256').update(pcm).digest('hex'),
    },
    invocation('clip-grant'),
  )
  expect(await hub.clipChunk('rover', 'clip-grant', pcm.subarray(0, 2048))).toBeUndefined()
  expect(device.clip('remote-clip')).toBeUndefined()
  expect(await hub.clipChunk('rover', 'clip-grant', pcm.subarray(2048))).toEqual({
    id: 'remote-clip',
    state: 'sent',
  })
  expect(device.clip('remote-clip')).toMatchObject({ rate: 16000, channels: 1, pcm })
  await hub.call('rover', 'move', { x: 2 }, invocation('held'))
  const refused = await hub.call('rover', 'move', { x: 1 }, invocation('busy'))
  expect(refused.outcome).toMatchObject({
    status: 'rejected',
    reason: 'busy',
    holder: { call: 'held', job: 'held', tool: 'move', caller: 'agent' },
  })
  await hub.effect('pause', 'rover', { call: 'held' }, invocation('pause-held'))
  expect((await hub.journal.read('held'))?.phase).toBe('paused')
  await hub.effect('resume', 'rover', { call: 'held' }, invocation('resume-held'))
  finishMove = true
  await vi.waitFor(async () =>
    expect((await hub.journal.read('held'))?.outcome).toMatchObject({ status: 'done' }),
  )
  const lease = await hub.manualLease('rover', invocation('remote-lease'))
  await hub.manual('rover', lease.operationId, { vx: 0.5 })
  await vi.waitFor(() => expect(axes).toContainEqual({ vx: 0.5 }))
  const stopped = vi.spyOn(device, 'stop')
  expect(await hub.shutdown('disable')).toEqual({ state: 'settled' })
  life.abort()
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledWith('peer-disconnect'))
  expect(remote.connected).toBe(false)
  expect(server.address()).toBeTruthy()
  await expect(hub.call('rover', 'move', { x: 2 }, invocation('late'))).rejects.toThrow()
})
