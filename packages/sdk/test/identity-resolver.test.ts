import { PassThrough } from 'node:stream'
import { connectWindowsPipe } from '@agnes/system-node/windows-pipe'
import { afterEach, expect, it, vi } from 'vitest'
import { TransportClosed } from '../src/errors.js'
import { unixTransport } from '../src/transport/unix.node.js'

vi.mock('@agnes/system-node/windows-pipe', () => ({ connectWindowsPipe: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})
const path = '\\\\.\\pipe\\sdk-deadline'
const identity = { pid: 123, processStartId: 'win32:123:456' }

it('bounds trusted discovery by the default deadline and ignores a late identity', async () => {
  vi.useFakeTimers()
  let discovered!: (value: typeof identity) => void
  const resolveServerIdentity = () =>
    new Promise<typeof identity>((resolve) => {
      discovered = resolve
    })
  const onClose = vi.fn()
  let settled = false
  const result = unixTransport({ path, resolveServerIdentity })({ onMessage() {}, onClose }).catch(
    (error: unknown) => {
      settled = true
      return error
    },
  )
  await vi.advanceTimersByTimeAsync(2999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toBeInstanceOf(TransportClosed)
  discovered(identity)
  await vi.advanceTimersByTimeAsync(0)
  expect(connectWindowsPipe).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('aborts native connection at the shared deadline and destroys a late stream', async () => {
  vi.useFakeTimers()
  let connected!: (stream: Awaited<ReturnType<typeof connectWindowsPipe>>) => void
  vi.mocked(connectWindowsPipe).mockImplementation(
    () =>
      new Promise((resolve) => {
        connected = resolve
      }),
  )
  const onClose = vi.fn()
  const result = unixTransport({
    path,
    resolveServerIdentity: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      return identity
    },
  })({ onMessage() {}, onClose }).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(2000)
  const signal = vi.mocked(connectWindowsPipe).mock.calls[0]?.[0].signal
  expect(signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await result).toBeInstanceOf(TransportClosed)
  expect(signal?.aborted).toBe(true)
  const late = new PassThrough()
  connected(late as unknown as Awaited<ReturnType<typeof connectWindowsPipe>>)
  await vi.advanceTimersByTimeAsync(0)
  expect(late.destroyed).toBe(true)
  expect(onClose).toHaveBeenCalledOnce()
})

it.each(['missing', 'rejected'] as const)(
  'fails closed for %s discovery without leaking private details',
  async (mode) => {
    const factory = unixTransport({
      path,
      resolveServerIdentity: async () => {
        if (mode === 'rejected') throw new Error('PRIVATE discovery path')
        return undefined as unknown as typeof identity
      },
    })
    const result = await factory({ onMessage() {}, onClose() {} }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(TransportClosed)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(connectWindowsPipe).not.toHaveBeenCalled()
  },
)

it('resolves a fresh identity for each attempt and snapshots it before native verification', async () => {
  const owner = { ...identity }
  const resolveServerIdentity = vi.fn(async () => owner)
  vi.mocked(connectWindowsPipe).mockImplementation(
    async () => new PassThrough() as unknown as Awaited<ReturnType<typeof connectWindowsPipe>>,
  )
  const factory = unixTransport({ path, resolveServerIdentity })
  const handlers = { onMessage() {}, onClose() {} }
  await (await factory(handlers)).close()
  owner.pid = 789
  owner.processStartId = 'win32:789:999'
  await (await factory(handlers)).close()
  expect(resolveServerIdentity).toHaveBeenCalledTimes(2)
  expect(
    vi.mocked(connectWindowsPipe).mock.calls.map(([options]) => [options.pid, options.processStartId]),
  ).toEqual([
    [123, 'win32:123:456'],
    [789, 'win32:789:999'],
  ])
})
