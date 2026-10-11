import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/**
 * Behavioral tests for `fetchSurfaceMountLookup`: one read at start and no polling, on-demand
 * re-reads that run one at a time and at most once per retry window, last-known-good retention on a
 * later failure, and fail-soft-to-"no mount" on a first-ever failure. These do NOT re-verify the RPC protocol itself (the `{mount, host, port}`
 * shape (including package/surface identity), the wire format) -- that is
 * `packages/daemon/test/surface-mounts-rpc.test.ts` and
 * `packages/cli/launch/surface-mounts-e2e.test.ts`'s job, against a real daemon. Here, only
 * `createClient` is replaced with an in-memory test double (every other `@agnes/sdk` export --
 * `memoryJournal` included -- stays real), so there is no real socket I/O and `vi.useFakeTimers()` /
 * `vi.advanceTimersByTimeAsync` can move the clock deterministically without flakiness.
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

const answering = () =>
  vi.mocked(sdk.createClient).mockImplementation(
    () =>
      ({
        initialize: vi.fn(async () => undefined),
        surfaces: { mounts: vi.fn(async () => responses[Math.min(call++, responses.length - 1)]) },
        close: vi.fn(async () => undefined),
      }) as never,
  )

beforeEach(() => {
  vi.useFakeTimers()
  call = 0
  answering()
})
afterEach(() => {
  vi.useRealTimers()
  vi.mocked(sdk.createClient).mockClear()
})

it('reads the mount table once at start and does not poll', async () => {
  responses = [{ mounts: [surface(1111)] }, { mounts: [surface(2222)] }]
  const feed = await fetchSurfaceMountLookup(fakeBackend)
  expect(feed.lookup('/demo/version')).toMatchObject({ port: 1111 })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(feed.lookup('/demo/version')).toMatchObject({ port: 1111 })
  expect(sdk.createClient).toHaveBeenCalledTimes(1)
  await feed.close()
})

it('re-reads on request, one read at a time and at most once per retry window', async () => {
  responses = [{ mounts: [surface(1111)] }, { mounts: [surface(2222)] }, { mounts: [surface(3333)] }]
  const feed = await fetchSurfaceMountLookup(fakeBackend, { retryMs: 1_000 })
  feed.refresh() // still inside the window opened by the read at start
  await vi.advanceTimersByTimeAsync(0)
  expect(sdk.createClient).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1_000)
  feed.refresh()
  feed.refresh() // the first one is still in flight
  await vi.advanceTimersByTimeAsync(0)
  expect(sdk.createClient).toHaveBeenCalledTimes(2)
  expect(feed.lookup('/demo/version')).toMatchObject({ port: 2222 })
  await feed.close()
  await vi.advanceTimersByTimeAsync(1_000)
  feed.refresh() // closed
  await vi.advanceTimersByTimeAsync(0)
  expect(sdk.createClient).toHaveBeenCalledTimes(2)
})

it('M3: a later failed read keeps serving the last successful table (must NOT clear it)', async () => {
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
  const feed = await fetchSurfaceMountLookup(fakeBackend, { retryMs: 50 })
  expect(feed.lookup('/demo/version')).toBeDefined()
  await vi.advanceTimersByTimeAsync(50)
  feed.refresh() // this read throws
  await vi.advanceTimersByTimeAsync(0)
  expect(attempt).toBe(2)
  expect(feed.lookup('/demo/version')).toBeDefined() // still the first table, not undefined
  await feed.close()
})

it('M4: a first-ever failed read degrades to "nothing matches", and a later lookup asks again', async () => {
  let up = false
  vi.mocked(sdk.createClient).mockReturnValue({
    initialize: vi.fn(async () => undefined),
    surfaces: {
      mounts: vi.fn(async () => {
        if (!up) throw new Error('daemon unreachable')
        return { mounts: [surface(1111)] }
      }),
    },
    close: vi.fn(async () => undefined),
  } as never)
  const feed = await fetchSurfaceMountLookup(fakeBackend, { retryMs: 50 })
  expect(feed.lookup('/demo/version')).toBeUndefined() // inside the window: no new read
  up = true
  await vi.advanceTimersByTimeAsync(50)
  expect(feed.lookup('/demo/version')).toBeUndefined() // starts a read
  await vi.advanceTimersByTimeAsync(0)
  expect(feed.lookup('/demo/version')).toMatchObject({ port: 1111 })
  await feed.close()
})

it('drops mounts under the reserved /plugins, /admin and /skins prefixes (design WC3)', async () => {
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
  const feed = await fetchSurfaceMountLookup(fakeBackend)
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
  const second = await fetchSurfaceMountLookup(fakeBackend)
  expect(second.lookup('/pluginshelf/version')).toMatchObject({ port: 8888 })
  await feed.close()
  await second.close()
})
