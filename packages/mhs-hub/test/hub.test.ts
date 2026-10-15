import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { type BoundWakes, Hub, Journal, North } from '../src/index.js'
import { attach, authority, description, invocation, MemoryStore } from './fixtures.js'

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
  it('projects the resource holder as job/tool/caller and refuses manually disabled tool needs', async () => {
    const { hub } = setup()
    let finish!: () => void
    const work = new Promise<null>((r) => {
      finish = () => r(null)
    })
    attach(hub, {
      result: work,
      registration: {
        ...description,
        tools: (description.tools ?? []).map((tool) => ({ ...tool, needs: ['motors'] })),
      },
    })
    try {
      await hub.call('rover', 'move', { x: 1 }, invocation('holder'))
      const busy = await hub.call('rover', 'move', { x: 1 }, invocation('busy'))
      expect(busy.outcome).toMatchObject({
        status: 'rejected',
        reason: 'busy',
        holder: { job: 'holder', tool: 'move', caller: 'agent' },
      })
      await hub.effect('configure', 'rover', { sources: { motors: { on: false } } }, invocation('source-off'))
      const missing = await hub.call('rover', 'move', { x: 1 }, invocation('needs'))
      expect(missing.outcome).toMatchObject({ status: 'rejected', reason: 'needs', needs: ['motors'] })
    } finally {
      finish()
      await hub.shutdown()
    }
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
  it('coalesces multiple device completions into one bounded durable wake for the original lane', async () => {
    vi.useFakeTimers()
    try {
      const { hub, notifications } = setup()
      const first = attach(hub)
      hub.online({
        ...first.link,
        registration: { ...first.link.registration, device: { id: 'second', kind: 'robot' } },
      })
      await hub.call('rover', 'move', { x: 1 }, invocation('first-completion'))
      await hub.call('second', 'move', { x: 1 }, invocation('second-completion'))
      await vi.advanceTimersByTimeAsync(0)
      expect(notifications.size).toBe(0)
      await vi.advanceTimersByTimeAsync(1001)
      expect([...notifications.values()]).toEqual([
        expect.objectContaining({
          target: { bindingId: 'bound-s1-lane1' },
          event: expect.objectContaining({
            name: 'mhs.operations',
            data: {
              operations: [
                expect.objectContaining({ operationId: expect.any(String), status: 'done' }),
                expect.objectContaining({ operationId: expect.any(String), status: 'done' }),
              ],
            },
          }),
        }),
      ])
      await hub.shutdown()
    } finally {
      vi.useRealTimers()
    }
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
    const configurations: boolean[] = []
    device.onConfigure = async (sources) => {
      const state = sources.video
      if (state && typeof state === 'object' && !Array.isArray(state)) configurations.push(state.on === true)
    }
    device.onObservation = () => true
    await expect(hub.subscribeMedia('rover', 'video', () => {})).rejects.toThrow('source-off')
    await hub.effect('configure', 'rover', { sources: { video: { on: true } } }, invocation('video-enable'))
    const first = await hub.subscribeMedia('rover', 'video', () => {})
    const second = await hub.subscribeMedia('rover', 'video', () => {})
    first()
    expect(configurations.at(-1)).toBe(true)
    expect(device.publish('video', { w: 1, h: 1, key: true }, new Uint8Array([1]))).toBe(true)
    second()
    second()
    await Promise.resolve()
    expect(configurations.at(-1)).toBe(false)
    expect(device.publish('video', { w: 1, h: 1, key: true }, new Uint8Array([1]))).toBe(false)
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

describe('Hub source and world contracts', () => {
  it('waits for strictly newer data, cancels and times out, and pages bounded values history and event replay', async () => {
    vi.useFakeTimers()
    try {
      let now = 1000
      const { hub } = setup(() => now)
      attach(hub, {
        registration: {
          ...description,
          sources: [
            { id: 'motors', kind: 'values', description: 'Motor values', fields: { n: { type: 'number' } } },
          ],
        },
      })
      hub.observation('rover', 'motors', { n: 1 })
      const controller = new AbortController()
      const cancelled = hub.read('rover', ['motors'], { since: now, signal: controller.signal })
      const rejected = expect(cancelled).rejects.toThrow('closed')
      controller.abort(new Error('closed'))
      await rejected
      let settled = false
      const pending = hub.read('rover', ['motors'], { since: now, history: true, limit: 1 }).then((v) => {
        settled = true
        return v
      })
      await vi.advanceTimersByTimeAsync(10)
      hub.observation('rover', 'motors', { n: 2 })
      await vi.advanceTimersByTimeAsync(10)
      expect(settled).toBe(false)
      now += 1000
      hub.observation('rover', 'motors', { n: 3 })
      const read = await pending
      expect(read.items[0]?.data).toEqual({ n: 3 })
      expect(read.items[0]?.history).toHaveLength(1)
      expect(read.items[0]?.nextCursor).toBe(1000)
      const page = await hub.read('rover', ['motors'], { history: true, cursor: 1000 })
      expect(page.items[0]?.history?.map((s) => s.data)).toEqual([{ n: 3 }])
      const timeout = hub.read('rover', ['motors'], { since: now, timeoutMs: 20 })
      await vi.advanceTimersByTimeAsync(21)
      expect((await timeout).items[0]?.data).toEqual({ state: 'timeout' })
      for (let n = 0; n < 150; n++) {
        now += 1000
        hub.observation('rover', 'motors', { n })
      }
      expect(
        (await hub.read('rover', ['motors'], { history: true, limit: 120 })).items[0]?.history,
      ).toHaveLength(120)
      const events = hub.events.page(undefined, 1)
      expect(events.more).toBe(true)
      const replay: unknown[] = []
      const off = hub.subscribe((e) => replay.push(e), events.cursor)
      expect(replay.length).toBeGreaterThan(0)
      expect(replay).not.toContainEqual(expect.objectContaining({ cursor: events.cursor }))
      off()
      now += 601_000
      expect(hub.events.page(events.cursor).gap).toBe(true)
      await hub.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })
  it('aggregates demand and rates per source, keeps pose slow, respects manual off, and gates video on keyframes', async () => {
    vi.useFakeTimers()
    try {
      const { hub } = setup()
      const { device, link } = attach(hub, {
        registration: {
          ...description,
          sources: [
            { id: 'pose', kind: 'pose', hz: 5, description: 'Position' },
            { id: 'front', kind: 'image', hz: 10, description: 'Still' },
            { id: 'video', kind: 'video', hz: 20, description: 'Video' },
          ],
        },
      })
      const configurations: Record<string, unknown>[] = []
      device.onConfigure = async (sources) => {
        configurations.push(sources)
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(configurations.at(-1)).toMatchObject({
        pose: { on: true, hz: 1 },
        front: { on: false },
        video: { on: false },
      })
      const first: unknown[] = [],
        second: unknown[] = []
      const a = await hub.subscribeMedia('rover', 'front', (s) => first.push(s), 2)
      const b = await hub.subscribeMedia('rover', 'front', (s) => second.push(s), 4)
      expect(configurations.at(-1)?.front).toMatchObject({ on: true, hz: 4 })
      hub.observation('rover', 'front', { w: 1, h: 1 }, new Uint8Array([1]), 'image/png')
      await vi.advanceTimersByTimeAsync(250)
      hub.observation('rover', 'front', { w: 1, h: 1 }, new Uint8Array([2]), 'image/png')
      expect(first).toHaveLength(1)
      expect(second).toHaveLength(2)
      await hub.effect('configure', 'rover', { sources: { front: { on: false } } }, invocation('off'))
      expect(configurations.at(-1)?.front).toEqual({ on: false })
      const c = await hub.subscribeMedia('rover', 'front', () => {}, 8)
      expect(configurations.at(-1)?.front).toEqual({ on: false })
      a()
      b()
      c()
      const sent: unknown[] = []
      const requests = vi.spyOn(link, 'request')
      const video = await hub.subscribeMedia('rover', 'video', (sample) => sent.push(sample))
      expect(requests).toHaveBeenCalledWith('mhs/keyframe', { source: 'video' })
      hub.observation('rover', 'video', { w: 1, h: 1, key: false }, new Uint8Array([1]))
      expect(sent).toEqual([])
      hub.observation('rover', 'video', { w: 1, h: 1, key: true }, new Uint8Array([2]))
      expect(sent).toHaveLength(1)
      await hub.keyframe('rover', 'video')
      hub.observation('rover', 'video', { w: 1, h: 1, key: false }, new Uint8Array([3]))
      expect(sent).toHaveLength(1)
      video()
      await vi.advanceTimersByTimeAsync(0)
      expect(configurations.at(-1)?.video).toEqual({ on: false })
      await hub.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })
  it('projects fixed placement and dynamic age/error/odometry trust, uses the smallest zone and persists legal frame updates', async () => {
    let now = 1000
    const { hub, store, wakes } = setup(() => now)
    const registration = {
      ...description,
      localization: 'fixed' as const,
      placement: { map: 'site', x: 1, y: 1, yaw: 0 },
      maps: [
        {
          id: 'site',
          bounds: [0, 0, 10, 10] as [number, number, number, number],
          places: [
            {
              id: 'all',
              name: 'All',
              points: [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
              ] as [number, number][],
            },
            {
              id: 'small',
              name: 'Small',
              points: [
                [0, 0],
                [2, 0],
                [2, 2],
                [0, 2],
              ] as [number, number][],
            },
          ],
        },
      ],
    }
    const { link } = attach(hub, { registration })
    await vi.waitFor(async () => expect((await hub.maps())[0]?.places).toHaveLength(2))
    expect((await hub.read('rover')).device.trust).toBe('trusted')
    expect(await hub.world()).toMatchObject([{ entities: [{ ok: true, zone: 'small' }] }])
    const updated = {
      ...registration,
      device: { id: 'fixed2', kind: 'sensor' },
      maps: [
        {
          id: 'site',
          bounds: [-1, -1, 20, 20] as [number, number, number, number],
          places: [{ id: 'gate', name: 'Gate', at: [3, 3] as [number, number] }],
        },
      ],
    }
    hub.online({ ...link, registration: updated })
    await vi.waitFor(async () => expect((await hub.maps())[0]?.bounds).toEqual([-1, -1, 20, 20]))
    hub.offline('rover', link)
    const restarted = new Hub({ store, wakes, authority })
    expect((await restarted.maps())[0]?.places?.map((p) => p.id)).toEqual(['all', 'small', 'gate'])
    const dynamic = {
      ...description,
      localization: 'self' as const,
      sources: [
        { id: 'pose', kind: 'pose', description: 'Position', max_error_m: 0.5 },
        { id: 'odom', kind: 'odometry', description: 'Odometry' },
      ],
    }
    attach(hub, { registration: dynamic })
    expect((await hub.read('rover')).device.trust).toBe('lost')
    hub.observation('rover', 'odom', { x: 0, y: 0, yaw: 0, v: 0, w: 0 })
    hub.observation('rover', 'pose', { map: 'site', x: 1, y: 1, yaw: 0, ok: true })
    expect((await hub.read('rover')).device.trust).toBe('trusted')
    hub.observation('rover', 'pose', {
      map: 'site',
      x: 1,
      y: 1,
      yaw: 0,
      ok: true,
      cov: [1, 0, 0, 0, 1, 0, 0, 0, 0],
    })
    expect((await hub.read('rover')).device.positionReason).toBe('position-error')
    hub.observation('rover', 'pose', { map: 'site', x: 5, y: 1, yaw: 0, ok: true })
    expect((await hub.read('rover')).device.positionReason).toBe('odometry-disagreement')
    hub.observation('rover', 'pose', { map: 'site', x: 5, y: 1, yaw: 0, ok: false })
    expect((await hub.read('rover')).device.trust).toBe('uncertain')
    hub.observation('rover', 'pose', { map: 'site', x: 5, y: 1, yaw: 0, ok: true })
    now += 3001
    expect((await hub.read('rover')).device).toMatchObject({
      trust: 'uncertain',
      positionReason: 'stale-position',
    })
    now += 7000
    expect((await hub.read('rover')).device.trust).toBe('lost')
    await hub.shutdown()
  })
  it('binds binary clips to native admission, exact bytes, destination, one send and revocation', async () => {
    const { hub } = setup()
    const { device } = attach(hub)
    const bytes = new Uint8Array([1, 0, 2, 0])
    const spec = {
      id: 'speech',
      rate: 24000,
      channels: 1,
      bytes: 4,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    await expect(hub.clipLease('rover', spec, { ...invocation('bad-clip'), context: {} })).rejects.toThrow()
    await expect(hub.clipLease('rover', { ...spec, channels: 3 }, invocation('format'))).rejects.toThrow(
      'invalid-clip',
    )
    await hub.clipLease('rover', spec, invocation('clip'))
    await expect(hub.sendClip('rover', 'clip', new Uint8Array([0, 0, 0, 0]))).rejects.toThrow(
      'clip-payload-mismatch',
    )
    await expect(hub.sendClip('rover', 'clip', bytes)).rejects.toThrow('clip-grant-required')
    await hub.clipLease('rover', spec, invocation('good-clip'))
    expect(await hub.sendClip('rover', 'good-clip', bytes)).toEqual({ id: 'speech', state: 'sent' })
    expect(device.clip('speech')?.pcm).toEqual(bytes)
    await hub.clipLease('rover', { ...spec, id: 'chunked' }, invocation('chunked'))
    expect(await hub.clipChunk('rover', 'chunked', bytes.subarray(0, 2))).toBeUndefined()
    expect(device.clip('chunked')).toBeUndefined()
    expect(await hub.clipChunk('rover', 'chunked', bytes.subarray(2))).toEqual({
      id: 'chunked',
      state: 'sent',
    })
    expect(device.clip('chunked')?.pcm).toEqual(bytes)
    await expect(hub.clipChunk('rover', 'chunked', bytes)).rejects.toThrow('clip-grant-required')
    await hub.clipLease('rover', spec, invocation('revoked-clip'))
    await hub.stop()
    await expect(hub.sendClip('rover', 'revoked-clip', bytes)).rejects.toThrow('clip-grant-required')
    await hub.shutdown()
  })
})
