import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const surface = (port: number, mount = '/demo') => ({
  package: 'agnes/demo-surface',
  surfaceId: 'demo',
  mount,
  host: '127.0.0.1',
  port,
})
let mounts = [surface(1111)]
let read: () => Promise<{ mounts: ReturnType<typeof surface>[] }>
let handlers: Map<string, (value?: unknown) => void>
const closes: (() => Promise<void>)[] = []
const query = vi.fn(() => read())
const closeClient = vi.fn(async () => {})
vi.mock('@agnes/sdk', async (importActual) => ({
  ...(await importActual<typeof import('@agnes/sdk')>()),
  createClient: vi.fn(() => ({
    initialize: async () => {},
    on: (event: string, callback: (value?: unknown) => void) => {
      handlers.set(event, callback)
      return () => handlers.delete(event)
    },
    surfaces: { mounts: query },
    close: closeClient,
  })),
}))
const { fetchSurfaceMountLookup } = await import('./surface-mounts.js')
const backend = { socketPath: '/tmp/fake.sock', scope: { scopeID: 'test' } } as never
async function feed() {
  const result = await fetchSurfaceMountLookup(backend, { intervalMs: 50 })
  closes.push(result.close)
  await vi.advanceTimersByTimeAsync(0)
  return result
}
const changed = () =>
  handlers.get('notice')?.({ kind: 'packages_changed', detail: { mounts: [surface(9999)] } })
beforeEach(() => {
  vi.useFakeTimers()
  handlers = new Map()
  mounts = [surface(1111)]
  read = async () => ({ mounts })
  query.mockClear()
  closeClient.mockReset().mockResolvedValue()
})
afterEach(async () => {
  await Promise.all(closes.splice(0).map((close) => close()))
  vi.useRealTimers()
})

it('discovers additions, upgrades and stops from authoritative reads on events without idle polling', async () => {
  const current = await feed()
  expect(current.lookup('/demo/version')).toMatchObject({ port: 1111 })
  await vi.advanceTimersByTimeAsync(80000)
  expect(query).toHaveBeenCalledOnce()
  mounts = [surface(2222), surface(3333, '/new')]
  changed()
  await vi.advanceTimersByTimeAsync(0)
  expect(current.lookup('/demo/version')).toMatchObject({ port: 2222 })
  expect(current.lookup('/new')).toMatchObject({ port: 3333 })
  mounts = []
  changed()
  await vi.advanceTimersByTimeAsync(0)
  expect(current.ready()).toBe(true)
  expect(current.lookup('/demo')).toBeUndefined()
})

it('retains the last table on a failed read and retries initial failures and reconnects', async () => {
  read = async () => {
    throw new Error('offline')
  }
  const current = await feed()
  expect(current.ready()).toBe(false)
  read = async () => ({ mounts })
  await vi.advanceTimersByTimeAsync(50)
  expect(current.ready()).toBe(true)
  read = async () => {
    throw new Error('offline')
  }
  changed()
  await vi.advanceTimersByTimeAsync(0)
  expect(current.lookup('/demo')).toMatchObject({ port: 1111 })
  read = async () => ({ mounts: [surface(2222)] })
  handlers.get('reconnected')?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(current.lookup('/demo')).toMatchObject({ port: 2222 })
  await vi.advanceTimersByTimeAsync(500)
  expect(query).toHaveBeenCalledTimes(4)
})

it('replaces a terminal SDK connection after a graceful daemon shutdown', async () => {
  const current = await feed()
  handlers.get('closed')?.()
  mounts = [surface(4444)]
  await vi.advanceTimersByTimeAsync(50)
  expect(current.lookup('/demo')).toMatchObject({ port: 4444 })
  expect(handlers.has('notice')).toBe(true)
  await vi.advanceTimersByTimeAsync(500)
  expect(query).toHaveBeenCalledTimes(2)
})

it('coalesces invalidations during a read without losing the newest authoritative table', async () => {
  const current = await feed()
  let finish!: (value: { mounts: ReturnType<typeof surface>[] }) => void
  read = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  changed()
  await vi.advanceTimersByTimeAsync(0)
  changed()
  changed()
  try {
    expect(query).toHaveBeenCalledTimes(2)
    read = async () => ({ mounts: [surface(3333)] })
    finish({ mounts: [surface(2222)] })
    await vi.advanceTimersByTimeAsync(0)
    expect(current.lookup('/demo')).toMatchObject({ port: 3333 })
    expect(query).toHaveBeenCalledTimes(3)
  } finally {
    finish({ mounts: [] })
  }
})

it('drops reserved routes while preserving lookalikes and exact path boundaries', async () => {
  mounts = [
    '/admin',
    '/admin/demo',
    '/plugins',
    '/plugins/demo',
    '/skins',
    '/skins/demo',
    '/pluginshelf',
  ].map((path) => surface(1111, path))
  const current = await feed()
  for (const path of ['/admin', '/admin/demo', '/plugins/demo', '/skins/demo'])
    expect(current.lookup(path)).toBeUndefined()
  expect(current.lookup('/pluginshelf/file')).toBeDefined()
  expect(current.lookup('/pluginshelfx')).toBeUndefined()
})

it('returns before the first read, closes once and refuses publication after close', async () => {
  let finish!: (value: { mounts: ReturnType<typeof surface>[] }) => void
  let finishClose!: () => void
  read = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  closeClient.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishClose = resolve
      }),
  )
  const current = await feed()
  expect(current.ready()).toBe(false)
  const first = current.close()
  expect(current.close()).toBe(first)
  expect(handlers.size).toBe(0)
  finish({ mounts })
  finishClose()
  await first
  expect(closeClient).toHaveBeenCalledOnce()
  expect(current.lookup('/demo')).toBeUndefined()
  await vi.advanceTimersByTimeAsync(500)
  expect(query).toHaveBeenCalledOnce()
})
