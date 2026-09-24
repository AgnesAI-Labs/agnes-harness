import { afterEach, expect, it, vi } from 'vitest'
import { windowsConnectPipeSync } from '../src/index.js'
import { connectWindowsPipe } from '../src/windows-pipe.js'

vi.mock('../src/index.js', () => ({ windowsConnectPipeSync: vi.fn(), windowsReservePipeName: vi.fn() }))
afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})
const identity = { path: 'pipe', pid: 123, processStartId: '456' }
const busy = Object.assign(new Error('busy'), { win32Code: 231 })

it.each(['456', 'win32:123:456'])(
  'passes verified time from %s without changing the expected PID',
  async (processStartId) => {
    const failure = new Error('native probe reached')
    vi.mocked(windowsConnectPipeSync).mockImplementation(() => {
      throw failure
    })
    await expect(connectWindowsPipe({ ...identity, processStartId })).rejects.toBe(failure)
    expect(windowsConnectPipeSync).toHaveBeenCalledExactlyOnceWith('pipe', 123, '456')
  },
)

it.each([
  'win32:124:456',
  'win32:0123:456',
  'win32:123:0456',
  'win32:123:0',
  'win32:123:456:extra',
  'win32:123:18446744073709551616',
  '18446744073709551616',
  '456\n',
  'darwin:123:456',
])('rejects malformed or conflicting identity %j before opening a pipe', async (processStartId) => {
  await expect(connectWindowsPipe({ ...identity, processStartId })).rejects.toMatchObject({ code: 'EINVAL' })
  expect(windowsConnectPipeSync).not.toHaveBeenCalled()
})

it('retries only busy connections and snapshots the expected identity', async () => {
  vi.useFakeTimers()
  const owner = { read: vi.fn(async () => null), write: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  vi.mocked(windowsConnectPipeSync)
    .mockImplementationOnce(() => {
      throw busy
    })
    .mockReturnValue(owner)
  const options = { ...identity }
  const connecting = connectWindowsPipe(options)
  options.pid = 789
  await vi.advanceTimersByTimeAsync(10)
  const stream = await connecting
  expect(windowsConnectPipeSync).toHaveBeenLastCalledWith(identity.path, 123, '456')
  const closed = new Promise<void>((resolve) => stream.once('close', resolve))
  stream.destroy()
  await closed
  expect(owner.close).toHaveBeenCalledOnce()
})

it.each(['E_PIPE_IDENTITY', 'EACCES', 'ENOENT'])('does not retry %s', async (code) => {
  const failure = Object.assign(new Error(code), { code })
  vi.mocked(windowsConnectPipeSync).mockImplementation(() => {
    throw failure
  })
  await expect(connectWindowsPipe(identity)).rejects.toBe(failure)
  expect(windowsConnectPipeSync).toHaveBeenCalledOnce()
})

it('does not make a late attempt when its retry wakes after the deadline', async () => {
  vi.useFakeTimers()
  vi.mocked(windowsConnectPipeSync).mockImplementation(() => {
    throw busy
  })
  const result = expect(connectWindowsPipe({ ...identity, timeoutMs: 25 })).rejects.toMatchObject({
    code: 'ETIMEDOUT',
  })
  await vi.advanceTimersByTimeAsync(25)
  await result
  expect(windowsConnectPipeSync).toHaveBeenCalledOnce()
})

it('cancels a scheduled retry without opening another connection', async () => {
  vi.mocked(windowsConnectPipeSync).mockImplementation(() => {
    throw busy
  })
  const controller = new AbortController()
  const result = expect(connectWindowsPipe({ ...identity, signal: controller.signal })).rejects.toMatchObject(
    { name: 'AbortError' },
  )
  controller.abort()
  await result
  expect(windowsConnectPipeSync).toHaveBeenCalledOnce()
})

it('allows no attempts after pre-cancellation and only one when timeout is zero', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(connectWindowsPipe({ ...identity, signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(windowsConnectPipeSync).not.toHaveBeenCalled()
  vi.mocked(windowsConnectPipeSync).mockImplementation(() => {
    throw busy
  })
  await expect(connectWindowsPipe({ ...identity, timeoutMs: 0 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
  expect(windowsConnectPipeSync).toHaveBeenCalledOnce()
})
