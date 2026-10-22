import type { Client } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import type { LocalBackend } from './backend.js'
import { createDaemonLink, DaemonUnavailableError } from './daemon-link.js'

const TIMING = { windowMs: 300, attemptMs: 50, baseMs: 5, maxMs: 20, cooldownMs: 100 }

function backend(over: { scopeID?: string; origin?: string; generation?: string } = {}): LocalBackend {
  return {
    scope: { scopeID: over.scopeID ?? 'scope-1', profile: 'local-dev', home: '/h', dataDir: '/d' },
    discovery: {
      profile: 'local-dev',
      dataDir: '/d',
      owner: { generation: over.generation ?? 'g1' },
      web: { url: 'ws://127.0.0.1:1/', origin: over.origin ?? 'http://127.0.0.1:4177' },
    },
    socketPath: '/d/agnes.sock',
    web: { url: 'ws://127.0.0.1:1/', origin: over.origin ?? 'http://127.0.0.1:4177', token: 't' },
    closeClient: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as LocalBackend
}

function fakeClient(name: string) {
  const listeners: { event: string; handler: (payload: unknown) => void }[] = []
  const client = {
    name,
    isClosed: false,
    connectionState: 'connected' as string,
    listeners,
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      listeners.push({ event, handler })
      return () => undefined
    }),
    close: vi.fn(async () => undefined),
    packages: { list: vi.fn(async () => name) },
  }
  return client
}

function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  if (value === undefined) throw new Error(`no client ${index}`)
  return value
}

function setup(attach: Parameters<typeof createDaemonLink>[1]) {
  const made: ReturnType<typeof fakeClient>[] = []
  const link = createDaemonLink(backend(), attach, TIMING)
  const proxy = link.client(() => {
    const next = fakeClient(`client-${made.length + 1}`)
    made.push(next)
    return next as unknown as Client
  }) as unknown as ReturnType<typeof fakeClient>
  return { link, proxy, made }
}

it('replaces a client the daemon closed for good, with one verified re-attach for concurrent callers', async () => {
  const attach = vi.fn(async () => backend({ generation: 'g2' }))
  const { link, proxy, made } = setup(attach)
  expect(await proxy.packages.list()).toBe('client-1')
  at(made, 0).isClosed = true // the SDK latches this on a daemon `shutting_down` notice
  const results = await Promise.all([proxy.packages.list(), proxy.packages.list()])
  expect(results).toEqual(['client-2', 'client-2'])
  expect(attach).toHaveBeenCalledTimes(1)
  expect(at(made, 0).close).toHaveBeenCalled()
  expect(link.backend().discovery.owner.generation).toBe('g2')
  await link.close()
})

it('keeps event subscriptions and tells the owner about each replacement', async () => {
  const replaced: unknown[] = []
  const made: ReturnType<typeof fakeClient>[] = []
  const link = createDaemonLink(backend(), async () => backend({ generation: 'g2' }), TIMING)
  const proxy = link.client(
    () => {
      const next = fakeClient(`client-${made.length + 1}`)
      made.push(next)
      return next as unknown as Client
    },
    (next) => replaced.push(next),
  )
  proxy.on('notice', () => undefined)
  at(made, 0).isClosed = true
  expect(await link.ensure()).toBe(true)
  expect(at(made, 1).listeners.map((entry) => entry.event)).toEqual(['notice'])
  expect(replaced).toEqual([at(made, 1)])
  await link.close()
})

it('refuses a daemon with another identity or Web origin and keeps trusting only the original', async () => {
  for (const other of [{ scopeID: 'someone-else' }, { origin: 'http://127.0.0.1:4999' }]) {
    const mismatched = backend(other)
    const attach = vi.fn(async () => mismatched)
    const { link, proxy, made } = setup(attach)
    at(made, 0).isClosed = true
    await expect(proxy.packages.list()).rejects.toBeInstanceOf(DaemonUnavailableError)
    expect(mismatched.closeClient).toHaveBeenCalled()
    expect(made).toHaveLength(1) // never rebound to the mismatched daemon
    expect(link.backend().scope.scopeID).toBe('scope-1')
    await link.close()
  }
})

it('bounds the retries, then fails fast for a cool-down instead of making every request wait again', async () => {
  const attach = vi.fn(async () => {
    throw new Error('daemon is down')
  })
  const { link, proxy, made } = setup(attach)
  at(made, 0).isClosed = true
  const started = Date.now()
  await expect(proxy.packages.list()).rejects.toBeInstanceOf(DaemonUnavailableError)
  expect(Date.now() - started).toBeLessThan(TIMING.windowMs + 200)
  const attempts = attach.mock.calls.length
  expect(attempts).toBeGreaterThan(1)
  expect(attempts).toBeLessThan(TIMING.windowMs / TIMING.baseMs)
  const quick = Date.now()
  expect(await link.ensure()).toBe(false)
  expect(Date.now() - quick).toBeLessThan(20)
  expect(attach).toHaveBeenCalledTimes(attempts)
  await link.close()
})

it('never replays a call whose connection dropped under it', async () => {
  const { link, proxy, made } = setup(async () => backend({ generation: 'g2' }))
  at(made, 0).packages.list.mockRejectedValueOnce(new Error('transport closed'))
  await expect(proxy.packages.list()).rejects.toThrow('transport closed')
  at(made, 0).isClosed = true
  expect(await proxy.packages.list()).toBe('client-2')
  expect(at(made, 0).packages.list).toHaveBeenCalledTimes(1)
  await link.close()
})

it('cancels a reconnect in flight on close and leaves no timers', async () => {
  vi.useFakeTimers()
  try {
    let aborted = false
    const attach = vi.fn(
      (signal: AbortSignal) =>
        new Promise<LocalBackend>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('cancelled'))
          })
        }),
    )
    const { link, proxy, made } = setup(attach)
    at(made, 0).isClosed = true
    const pending = proxy.packages.list().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    expect(attach).toHaveBeenCalledTimes(1)
    await link.close()
    expect(aborted).toBe(true)
    expect(await pending).toBeInstanceOf(DaemonUnavailableError)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('waits a bounded time for the SDK to finish its own reconnect after a crash', async () => {
  const { link, proxy, made } = setup(async () => backend())
  at(made, 0).connectionState = 'reconnecting'
  setTimeout(() => {
    at(made, 0).connectionState = 'connected'
  }, 40)
  expect(await proxy.packages.list()).toBe('client-1')
  at(made, 0).connectionState = 'reconnecting'
  await expect(proxy.packages.list()).rejects.toBeInstanceOf(DaemonUnavailableError)
  await link.close()
})
