import { PassThrough } from 'node:stream'
import { startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import { afterEach, expect, it, vi } from 'vitest'
import { ownedWindowsBuild } from './owned-build.js'

vi.mock('@agnes/system-node/process-spawn', () => ({ startWindowsJobProcess: vi.fn() }))
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('waits for job cleanup after timeout before releasing build output', async () => {
  vi.useFakeTimers()
  let finish!: (value: { code: number | null; signal: string | null; cancelled: boolean }) => void
  const child = {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    terminate: vi.fn(),
    completion: new Promise<{ code: number | null; signal: string | null; cancelled: boolean }>((resolve) => {
      finish = resolve
    }),
  }
  vi.mocked(startWindowsJobProcess).mockResolvedValue(child)
  let settled = false
  const pending = ownedWindowsBuild(
    'node',
    ['build'],
    '/test',
    { TEST: 'yes', MISSING: undefined },
    100,
  ).then((result) => {
    settled = true
    return result
  })
  await vi.advanceTimersByTimeAsync(0)
  child.stdout.write('build output')
  expect(child.stdin.writableEnded).toBe(true)
  expect(vi.mocked(startWindowsJobProcess).mock.calls[0]?.[1].env).toEqual({ TEST: 'yes' })
  await vi.advanceTimersByTimeAsync(100)
  expect(vi.mocked(startWindowsJobProcess).mock.calls[0]?.[1].signal?.aborted).toBe(true)
  expect(settled).toBe(false)
  finish({ code: null, signal: 'SIGKILL', cancelled: true })
  expect(await pending).toEqual({ code: 124, output: 'build output' })
  expect(vi.getTimerCount()).toBe(0)
})

it('propagates job startup failure and clears its deadline', async () => {
  vi.useFakeTimers()
  vi.mocked(startWindowsJobProcess).mockRejectedValue(new Error('job startup failed'))
  await expect(ownedWindowsBuild('node', [], '/test', {})).rejects.toThrow('job startup failed')
  expect(vi.getTimerCount()).toBe(0)
})
