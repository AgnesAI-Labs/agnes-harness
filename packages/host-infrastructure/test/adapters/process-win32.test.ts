import { PassThrough } from 'node:stream'
import { SHELL_STDIN_SENTINEL } from '@agnes/extension-api'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ start: vi.fn(), dispose: vi.fn() }))
vi.mock('@agnes/system-node/process-spawn', () => ({
  startWindowsJobProcess: mocks.start,
  mergeWindowsEnvironment: (...layers: object[]) => Object.assign({}, ...layers),
}))
vi.mock('../../src/adapters/powershell-file.js', () => ({
  preparePowerShellFile: (_: unknown, argv: string[]) => ({ argv, dispose: mocks.dispose }),
}))

import { createExec } from '../../src/adapters/exec.js'
import { openWindowsProcess } from '../../src/adapters/process-win32.js'

const options = { nodeExecutable: 'C:\\node.exe', baseEnv: {} }
beforeEach(() => {
  vi.resetAllMocks()
})
it('reports cleanup failure at natural exit and every subsequent close', async () => {
  const error = new Error('Job cleanup failed')
  mocks.start.mockResolvedValue({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    completion: Promise.resolve({ code: 0, signal: null, error }),
    terminate() {},
  })
  const handle = await openWindowsProcess({ argv: ['node'], cwd: 'C:\\work' }, options)
  expect(await handle.exited).toMatchObject({ code: 0, error })
  await expect(handle.close()).rejects.toBe(error)
  await expect(handle.close()).rejects.toBe(error)
})
it('keeps startup and temporary-file cleanup errors together', async () => {
  mocks.start.mockRejectedValue(new Error('start failed'))
  mocks.dispose.mockImplementation(() => {
    throw new Error('dispose failed')
  })
  await expect(openWindowsProcess({ argv: ['node'], cwd: 'C:\\work' }, options)).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ message: 'start failed' }),
      expect.objectContaining({ message: 'dispose failed' }),
    ],
  })
})
it('still stops ordinary commands when an interactive process reports cleanup failure', async () => {
  const error = new Error('interactive cleanup failed')
  let finish!: (result: { code: number; signal: null; cancelled: boolean }) => void
  const completion = new Promise<{ code: number; signal: null; cancelled: boolean }>((resolve) => {
    finish = resolve
  })
  let cancelled = false
  const pipes = () => ({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  mocks.start.mockResolvedValueOnce({
    ...pipes(),
    completion: Promise.resolve({ code: 0, signal: null, error }),
    terminate() {},
  })
  mocks.start.mockImplementationOnce((_, options) => {
    options.signal.addEventListener('abort', () => {
      cancelled = true
    })
    return Promise.resolve({ ...pipes(), completion, terminate() {} })
  })
  const exec = createExec({ windowsNodeExecutable: 'C:\\node.exe' })
  const interactive = await exec.openProcess!(['agent'], { cwd: 'C:\\work' })
  expect((await interactive.exited).error).toBe(error)
  const running = exec.run(['agent'], { cwd: 'C:\\work' })
  let settled = false
  const closing = exec.killAll().then(
    () => {
      settled = true
      return undefined
    },
    (failure: unknown) => {
      settled = true
      return failure
    },
  )
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(cancelled).toBe(true)
    expect(settled).toBe(false)
    finish({ code: 0, signal: null, cancelled: true })
    expect(await closing).toMatchObject({ errors: [error] })
    expect(await running).toMatchObject({ signal: 'SIGKILL' })
    await expect(exec.killAll()).rejects.toMatchObject({ errors: [error] })
  } finally {
    finish({ code: 0, signal: null, cancelled: false })
    await running
    await closing
  }
})
it.each([
  { argv: [SHELL_STDIN_SENTINEL], cwd: 'C:\\work' },
  { argv: [SHELL_STDIN_SENTINEL, 'ignored'], cwd: 'C:\\work' },
  { argv: ['node'], cwd: 'C:\\work', pty: { columns: 80, rows: 24 } },
])('refuses unsupported intent before starting a process', async (request) => {
  await expect(openWindowsProcess(request, options)).rejects.toThrow(/unavailable|PTY/)
  expect(mocks.start).not.toHaveBeenCalled()
})
