import type { Auth } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createClient } from '../src/client.js'
import { RequestTimeout, TransportClosed } from '../src/errors.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

afterEach(() => {
  vi.useRealTimers()
})
it('applies the default 10000ms to auth, discards late credentials and allows a fresh attempt', async () => {
  vi.useFakeTimers()
  const f = fakeEndpoint({ initialize: () => ({ protocolVersion: 1, agentCapabilities: {} }) })
  let late!: (auth: Auth) => void
  let signal: AbortSignal | undefined
  let calls = 0
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    authProviders: {
      local: () => ({
        kind: 'local',
        build: async (ctx) => {
          calls++
          signal = ctx.signal
          return calls === 1
            ? new Promise<Auth>((resolve) => {
                late = resolve
              })
            : { kind: 'local' }
        },
      }),
    },
  })
  try {
    let settled = false
    const outcome = client.initialize().catch((error: unknown) => {
      settled = true
      return error
    })
    await vi.advanceTimersByTimeAsync(9999)
    expect(settled).toBe(false)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
    expect(await outcome).toMatchObject({ method: 'initialize', timeoutMs: 10000 })
    expect(await outcome).toBeInstanceOf(RequestTimeout)
    expect(signal?.aborted).toBe(true)
    late({ kind: 'local' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.calls).toEqual([])
    await client.initialize()
    expect(calls).toBe(2)
    expect(f.calls.map((call) => call.method)).toEqual(['initialize'])
  } finally {
    await client.close()
  }
  expect(vi.getTimerCount()).toBe(0)
})
it('close interrupts an auth wait and prevents late or subsequent initialization', async () => {
  vi.useFakeTimers()
  const f = fakeEndpoint({ initialize: () => ({ protocolVersion: 1, agentCapabilities: {} }) })
  let late!: (auth: Auth) => void
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    authProviders: {
      local: () => ({
        kind: 'local',
        build: () =>
          new Promise<Auth>((resolve) => {
            late = resolve
          }),
      }),
    },
  })
  const outcome = client.initialize().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  await client.close()
  expect(await outcome).toBeInstanceOf(TransportClosed)
  late({ kind: 'local' })
  await vi.advanceTimersByTimeAsync(0)
  await expect(client.initialize()).rejects.toBeInstanceOf(TransportClosed)
  expect(f.calls).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
})
it('uses one deadline for identity lookup plus auth rather than granting each phase a fresh timeout', async () => {
  vi.useFakeTimers()
  const f = fakeEndpoint({ initialize: () => ({ protocolVersion: 1, agentCapabilities: {} }) })
  const { memoryJournal } = await import('../src/journal.js')
  const journal = {
    ...memoryJournal(),
    clientId: () =>
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('cid'), 6000)
      }),
  }
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal,
    authProviders: {
      local: () => ({
        kind: 'local',
        build: () =>
          new Promise<Auth>((resolve) => {
            setTimeout(() => resolve({ kind: 'local' }), 6000)
          }),
      }),
    },
  })
  try {
    const outcome = client.initialize().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await outcome).toBeInstanceOf(RequestTimeout)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.calls).toEqual([])
  } finally {
    await client.close()
  }
})
it('bounds connection setup and closes a late transport without invoking auth', async () => {
  vi.useFakeTimers()
  let ready!: (transport: import('../src/transport/types.js').Transport) => void
  let closed = 0
  let authCalls = 0
  const f = fakeEndpoint({})
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    transportFactories: {
      inproc: () => () =>
        new Promise((resolve) => {
          ready = resolve
        }),
    },
    authProviders: {
      local: () => ({
        kind: 'local',
        async build() {
          authCalls++
          return { kind: 'local' }
        },
      }),
    },
  })
  const outcome = client.initialize().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(10000)
  expect(await outcome).toBeInstanceOf(RequestTimeout)
  const closing = client.close()
  ready({
    kind: 'inproc',
    send: async () => {
      throw new Error('unexpected send')
    },
    close: async () => {
      closed++
    },
  })
  await closing
  expect(closed).toBe(1)
  expect(authCalls).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
it('leaves only the remaining budget for a silent RPC peer after auth work', async () => {
  vi.useFakeTimers()
  const f = fakeEndpoint({ initialize: () => new Promise(() => {}) })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    authProviders: {
      local: () => ({
        kind: 'local',
        build: () =>
          new Promise<Auth>((resolve) => {
            setTimeout(() => resolve({ kind: 'local' }), 6000)
          }),
      }),
    },
  })
  try {
    const outcome = client.initialize().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await outcome).toBeInstanceOf(RequestTimeout)
    expect(f.calls.map((call) => call.method)).toEqual(['initialize'])
  } finally {
    await client.close()
  }
  expect(vi.getTimerCount()).toBe(0)
})
it.each([-1, Infinity, NaN, 2_147_483_648])('refuses invalid initialize timer %s', (initialize) => {
  const f = fakeEndpoint({})
  expect(() =>
    createClient({ transport: { kind: 'inproc', endpoint: f.endpoint }, timeouts: { initialize } }),
  ).toThrow(/^invalid initialize timeout$/)
})
