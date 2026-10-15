import { describe, expect, it, vi } from 'vitest'
import { type BoundWakes, Hub, Journal, North } from '../src/index.js'
import { attach, authority, invocation, MemoryStore } from './fixtures.js'

function setup(now?: () => number) {
  const notifications = new Map<string, unknown>()
  const wakes: BoundWakes = {
    async enqueue(input) {
      notifications.set(input.idempotencyKey, input)
      return { wakeId: input.idempotencyKey, state: 'queued' }
    },
  }
  const store = new MemoryStore()
  const hub = new Hub({ store, wakes, authority, ...(now ? { now } : {}) })
  return { hub, store, wakes, notifications }
}
describe('Hub authority, tasks and recovery', () => {
  it('does not dispatch without trusted admission and never repeats a completed or unknown command', async () => {
    const { hub, store, wakes } = setup()
    const { link } = attach(hub)
    const dispatch = vi.spyOn(link, 'call')
    await expect(
      hub.call('rover', 'move', { x: 1 }, { ...invocation('bad'), context: { approved: true } }),
    ).rejects.toThrow()
    expect(dispatch).not.toHaveBeenCalled()
    const first = await hub.call('rover', 'move', { x: 99 }, invocation('one'))
    expect(first.state).toBe('running')
    await vi.waitFor(async () => expect((await hub.journal.read('one'))?.state).toBe('terminal'))
    const receipt = await hub.call('rover', 'move', { x: 99 }, invocation('one'))
    expect(receipt.outcome).toMatchObject({ status: 'done', data: 2, notes: ['args.x: clamped'] })
    expect(dispatch).toHaveBeenCalledTimes(1)
    await expect(hub.call('rover', 'move', { x: 0 }, invocation('one'))).rejects.toThrow('ID_CONFLICT')
    await hub.journal.accept('rover', { cmd: 'possibly-dispatched' }, invocation('lost'))
    const recovered = new Journal(store, wakes)
    await recovered.recover()
    expect((await recovered.read('lost'))?.outcome).toMatchObject({ status: 'unknown', reason: 'restart' })
    expect(dispatch).toHaveBeenCalledTimes(1)
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const raceHub = new Hub({
      store: new MemoryStore(),
      wakes,
      authority: {
        async assertActive() {},
        async admit() {
          await pending
        },
      },
    })
    const raced = attach(raceHub)
    const raceDispatch = vi.spyOn(raced.link, 'call')
    const request = raceHub.call('rover', 'move', { x: 1 }, invocation('racing-stop'))
    await Promise.resolve()
    await Promise.resolve()
    await raceHub.stop()
    release?.()
    expect((await request).outcome).toMatchObject({ status: 'interrupted', reason: 'stop' })
    expect(raceDispatch).not.toHaveBeenCalled()
  })
  it('commits terminal and outbox together and retries notification with a stable bound identity', async () => {
    const { hub, store } = setup()
    await hub.journal.accept('rover', {}, invocation('long'))
    await hub.journal.finish('long', { status: 'done' })
    expect((await store.scan({ prefix: 'outbox/', limit: 10 })).rows).toHaveLength(1)
    let delivered = false
    const ids: string[] = []
    const resumed = new Journal(store, {
      async enqueue(input) {
        ids.push(input.idempotencyKey)
        if (!delivered) {
          delivered = true
          throw new Error('lost response')
        }
        return { wakeId: 'wake', state: 'queued' }
      },
    })
    await expect(resumed.flush()).rejects.toThrow()
    await resumed.flush()
    expect(ids[0]).toBe(ids[1])
    expect((await store.scan({ prefix: 'outbox/', limit: 10 })).rows).toHaveLength(0)
  })
  it('persists watches, ignores existing samples, isolates cancellation and wakes the original lane', async () => {
    let now = 1000
    const { hub, store, wakes, notifications } = setup(() => now)
    attach(hub)
    const north = new North(hub)
    await north.effect(
      'watch',
      { device: 'rover', until: { state: 'battery', lt: 20 }, timeout: 10 },
      invocation('watch'),
    )
    await expect(
      north.effect('unwatch', { watch: 'watch' }, { ...invocation('other'), sessionId: 'other' }),
    ).rejects.toThrow('watch-owner-mismatch')
    const restarted = new Hub({ store, wakes, authority, now: () => now })
    await restarted.recover()
    expect((await restarted.journal.read('watch'))?.state).toBe('accepted')
    attach(restarted)
    restarted.state('rover', { battery: 5 })
    await restarted.watches.tick('rover')
    expect((await restarted.journal.read('watch'))?.outcome?.reason).toBe('condition')
    expect([...notifications.values()]).toContainEqual(
      expect.objectContaining({ target: { bindingId: 'bound-s1-lane1' } }),
    )
    await north.effect(
      'watch',
      { device: 'rover', until: { health: 'bad' }, timeout: 1 },
      invocation('timeout'),
    )
    now += 1001
    await hub.watches.tick()
    expect((await hub.journal.read('timeout'))?.outcome?.reason).toBe('timeout')
    expect((await restarted.read('rover')).device.health).toBe('bad')
    await north.effect('watch', { device: 'rover', until: { health: 'bad' } }, invocation('disabled-watch'))
    await hub.shutdown('disable')
    expect((await hub.journal.read('disabled-watch'))?.outcome).toMatchObject({
      status: 'interrupted',
      reason: 'disable',
    })
  })
  it('separates command and observation state, rejects video model reads, and stops every motion on disable', async () => {
    let now = 0
    const { hub } = setup(() => now)
    const { device, link } = attach(hub)
    hub.observation(
      'rover',
      'front',
      { w: 1, h: 1, b64: 'untrusted-inline-media' },
      new Uint8Array([1, 2]),
      'image/png',
    )
    expect((await hub.read('rover', ['front'])).items[0]?.data).toEqual({ w: 1, h: 1 })
    expect((await hub.read('rover', ['front'])).items[0]?.bytes).toEqual(new Uint8Array([1, 2]))
    await expect(hub.read('rover', ['video'])).rejects.toThrow('video-not-model-input')
    await expect(hub.manualLease('rover', { ...invocation('lease-bad'), context: {} })).rejects.toThrow()
    await hub.manualLease('rover', invocation('lease'))
    now += 30_001
    await expect(hub.manual('rover', 'lease', { vx: 1 })).rejects.toThrow('lease-expired')
    const stop = vi.spyOn(device, 'stop')
    expect(await hub.shutdown()).toEqual({ state: 'settled' })
    expect(stop).toHaveBeenCalled()
    await expect(hub.call('rover', 'move', { x: 1 }, invocation('after-disable'))).rejects.toThrow('disabled')
    vi.spyOn(link, 'request').mockRejectedValue(new Error('disconnected'))
    expect((await hub.stop('rover')).state).toBe('unknown')
  })
  it('bounds activity to seven days and keeps restoration facts outside the display window', async () => {
    let now = 0
    const { hub } = setup(() => now)
    await hub.activity.append('old', null)
    await hub.journal.accept('rover', {}, invocation('pending'))
    now += 8 * 86400_000
    await hub.activity.append('new', null)
    expect((await hub.activity.list()).events.map((e) => e.type)).toEqual(['new'])
    expect(await hub.journal.read('pending')).toBeDefined()
    expect((await hub.activity.list()).earliest).toBe(now)
  })
})
