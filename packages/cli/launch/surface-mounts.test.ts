import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/**
 * Behavioral tests for the poller `fetchSurfaceMountLookup`/`fetchSurfaceMountProxy` now are (spec
 * RC1): refresh cadence, last-known-good retention on a later failure, and explicit first-success readiness
 * after an initial failure. These do NOT re-verify the RPC protocol itself (the `{mount, host, port}`
 * shape (including package/surface identity), the wire format) -- that is
 * `packages/daemon/test/surface-mounts-rpc.test.ts` and
 * `packages/cli/launch/surface-mounts-e2e.test.ts`'s job, against a real daemon. Here, only
 * `createClient` is replaced with an in-memory test double (every other `@agnes/sdk` export --
 * `memoryJournal` included -- stays real), so there is no real socket I/O and `vi.useFakeTimers()` /
 * `vi.advanceTimersByTimeAsync` can drive the poll ticks deterministically without flakiness.
 */
let responses: Array<{
  mounts: Array<{ package: string; surfaceId: string; mount: string; host: string; port: number }>
}> = []
let call = 0
const surface = (port: number) => ({
  package: 'agnes/demo-surface',
  surfaceId: 'demo',
  mount: '/demo',
  host: '127.0.0.1',
  port,
})
vi.mock('@agnes/sdk', async (importActual) => {
  const actual = await importActual<typeof import('@agnes/sdk')>()
  return {
    ...actual,
    createClient: vi.fn(() => ({
      initialize: vi.fn(async () => undefined),
      surfaces: { mounts: vi.fn(async () => responses[Math.min(call++, responses.length - 1)]) },
      close: vi.fn(async () => undefined),
    })),
  }
})

// Imported AFTER vi.mock so the mocked module is what surface-mounts.ts resolves against.
const sdk = await import('@agnes/sdk')
const { fetchSurfaceMountLookup } = await import('./surface-mounts.js')

const fakeBackend = { socketPath: '/tmp/fake.sock', scope: { scopeID: 'test' } } as never

beforeEach(() => {
  vi.useFakeTimers()
  call = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.mocked(sdk.createClient).mockClear()
})

it('refreshes the mount table on each interval tick, not just once at boot', async () => {
  responses = [{ mounts: [surface(1111)] }, { mounts: [surface(2222)] }]
  const feed = await fetchSurfaceMountLookup(fakeBackend, { intervalMs: 50 })
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.lookup('/demo/version')).toMatchObject({ port: 1111 })
  await vi.advanceTimersByTimeAsync(50)
  expect(feed.lookup('/demo/version')).toMatchObject({ port: 2222 })
  await feed.close()
})

it('M3: a later poll failure keeps serving the last successful table (must NOT clear it)', async () => {
  let attempt = 0
  vi.mocked(sdk.createClient).mockReturnValue({
    initialize: vi.fn(async () => undefined),
    surfaces: {
      mounts: vi.fn(async () => {
        attempt++
        if (attempt === 1) return { mounts: [surface(1111)] }
        throw new Error('daemon unreachable')
      }),
    },
    close: vi.fn(async () => undefined),
  } as never)
  const feed = await fetchSurfaceMountLookup(fakeBackend, { intervalMs: 50 })
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.lookup('/demo/version')).toBeDefined()
  await vi.advanceTimersByTimeAsync(50) // second tick throws
  expect(feed.lookup('/demo/version')).toBeDefined() // still the first table, not undefined
  await feed.close()
})

it('an initial failure leaves the feed unready rather than claiming a successful empty table', async () => {
  vi.mocked(sdk.createClient).mockReturnValue({
    initialize: vi.fn(async () => undefined),
    surfaces: {
      mounts: vi.fn(async () => {
        throw new Error('daemon unreachable')
      }),
    },
    close: vi.fn(async () => undefined),
  } as never)
  const feed = await fetchSurfaceMountLookup(fakeBackend, { intervalMs: 50 })
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.lookup('/demo/version')).toBeUndefined()
  expect(feed.ready()).toBe(false)
  await feed.close()
})

it('drops mounts under the reserved /plugins, /admin and /skins prefixes (design WC3)', async () => {
  // The preceding M4 case replaced the implementation with a throwing one and mockClear() does not
  // undo that, so restore the standard answering double explicitly.
  vi.mocked(sdk.createClient).mockImplementation(
    () =>
      ({
        initialize: vi.fn(async () => undefined),
        surfaces: { mounts: vi.fn(async () => responses[Math.min(call++, responses.length - 1)]) },
        close: vi.fn(async () => undefined),
      }) as never,
  )
  responses = [
    {
      mounts: [
        surface(1111),
        { ...surface(2222), mount: '/plugins' },
        { ...surface(3333), mount: '/plugins/demo' },
        { ...surface(4444), mount: '/admin' },
        { ...surface(5555), mount: '/admin/extra' },
        { ...surface(6666), mount: '/skins' },
        { ...surface(7777), mount: '/skins/midnight' },
      ],
    },
  ]
  const feed = await fetchSurfaceMountLookup(fakeBackend, { intervalMs: 50 })
  await vi.advanceTimersByTimeAsync(0)
  // A normal mount still resolves; every reserved-prefix row is refused instead of proxied.
  expect(feed.lookup('/demo/version')).toMatchObject({ port: 1111 })
  for (const path of [
    '/plugins',
    '/plugins/demo/panel.js',
    '/admin',
    '/admin/extra',
    '/skins',
    '/skins/midnight/skin.css',
  ]) {
    expect(feed.lookup(path), path).toBeUndefined()
  }
  // Lookalike prefixes that merely share a leading string are NOT reserved.
  responses = [{ mounts: [{ ...surface(8888), mount: '/pluginshelf' }] }]
  const second = await fetchSurfaceMountLookup(fakeBackend, { intervalMs: 50 })
  await vi.advanceTimersByTimeAsync(0)
  expect(second.lookup('/pluginshelf/version')).toMatchObject({ port: 8888 })
  await feed.close()
  await second.close()
})

it('does not let a late old response overwrite the newest table observed by a reader', async () => {
  let attempt = 0
  let finishOld!: (value: { mounts: ReturnType<typeof surface>[] }) => void
  const old = new Promise<{ mounts: ReturnType<typeof surface>[] }>((resolve) => {
    finishOld = resolve
  })
  vi.mocked(sdk.createClient).mockImplementation(
    () =>
      ({
        initialize: async () => {},
        surfaces: {
          mounts: async () => {
            attempt++
            if (attempt === 1) return { mounts: [surface(1111)] }
            if (attempt === 2) return old
            return { mounts: [surface(3333)] }
          },
        },
        close: async () => {},
      }) as never,
  )
  const feed = await fetchSurfaceMountLookup(fakeBackend, { intervalMs: 50 })
  await vi.advanceTimersByTimeAsync(0)
  try {
    await vi.advanceTimersByTimeAsync(100)
    // Before the fix, the second timer starts a newer query and publishes 3333 while the old
    // query remains pending. Resolving that old query then takes the public lookup back to 2222.
    const newestObserved = feed.lookup('/demo/version')?.port ?? 0
    finishOld({ mounts: [surface(2222)] })
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.lookup('/demo/version')?.port).toBeGreaterThanOrEqual(newestObserved)
    await vi.advanceTimersByTimeAsync(50)
    expect(feed.lookup('/demo/version')).toMatchObject({ port: 3333 })
  } finally {
    finishOld({ mounts: [surface(2222)] })
    await feed.close()
  }
})

it('returns during the first query and every close waits for query and connection cleanup', async () => {
  let finishQuery!: (value: { mounts: ReturnType<typeof surface>[] }) => void
  let finishClose!: () => void
  const query = new Promise<{ mounts: ReturnType<typeof surface>[] }>((resolve) => {
    finishQuery = resolve
  })
  const cleanup = new Promise<void>((resolve) => {
    finishClose = resolve
  })
  const clientClose = vi.fn(() => cleanup)
  vi.mocked(sdk.createClient).mockReturnValue({
    initialize: async () => {},
    surfaces: { mounts: () => query },
    close: clientClose,
  } as never)
  const feed = await fetchSurfaceMountLookup(fakeBackend, { intervalMs: 50 })
  expect(feed.ready()).toBe(false)
  await vi.advanceTimersByTimeAsync(150)
  const completed: number[] = []
  const first = feed.close().then(() => completed.push(1))
  const second = feed.close().then(() => completed.push(2))
  finishQuery({ mounts: [surface(2222)] })
  await vi.advanceTimersByTimeAsync(0)
  expect(clientClose).toHaveBeenCalledOnce()
  expect(completed).toEqual([])
  expect(feed.lookup('/demo/version')).toBeUndefined()
  finishClose()
  await Promise.all([first, second])
  expect(completed).toEqual([1, 2])
  await vi.advanceTimersByTimeAsync(150)
  expect(feed.ready()).toBe(false)
  expect(feed.lookup('/demo/version')).toBeUndefined()
})

it('distinguishes an empty successful table from not-ready and recovers after the first failure', async () => {
  let attempt = 0
  vi.mocked(sdk.createClient).mockReturnValue({
    initialize: async () => {},
    surfaces: {
      mounts: async () => {
        if (++attempt === 1) throw new Error('first query failed')
        return { mounts: [] }
      },
    },
    close: async () => {},
  } as never)
  const feed = await fetchSurfaceMountLookup(fakeBackend, { intervalMs: 50 })
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.ready()).toBe(false)
  await vi.advanceTimersByTimeAsync(50)
  expect(feed.ready()).toBe(true)
  expect(feed.lookup('/demo/version')).toBeUndefined()
  await feed.close()
})
