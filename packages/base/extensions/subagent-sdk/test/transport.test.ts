import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ start: vi.fn(), sea: vi.fn() }))
vi.mock('node:sea', () => ({ isSea: mocks.sea }))
vi.mock('@agnes/system-node/process-spawn', () => ({
  startWindowsJobProcess: mocks.start,
  mergeWindowsEnvironment: (...values: object[]) => Object.assign({}, ...values),
}))

import { ExternalProcess } from '../src/transport.js'

describe.runIf(process.platform === 'win32')('external child Windows lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.sea.mockReturnValue(false)
  })
  it('preserves cleanup failure separately from the business exit and rejects repeated cleanup', async () => {
    const error = new Error('Job cleanup failed')
    mocks.start.mockResolvedValue({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      completion: Promise.resolve({ code: 0, signal: null, error }),
      terminate() {},
    })
    const child = new ExternalProcess(
      { command: 'agent.exe', cwd: 'C:\\work' },
      () => {},
      () => {},
    )
    await child.ready
    expect(await child.exited).toMatchObject({ code: 0, error })
    await expect(child.kill()).rejects.toBe(error)
    await expect(child.kill()).rejects.toBe(error)
  })
  it('refuses using a SEA executable as Node and forwards the Host-provided runtime', async () => {
    mocks.sea.mockReturnValue(true)
    for (const launch of [undefined, { windowsNodeExecutable: process.execPath }]) {
      const child = new ExternalProcess(
        { command: 'agent.exe', cwd: 'C:\\work', ...(launch ? { launch } : {}) },
        () => {},
        () => {},
      )
      await expect(child.ready).rejects.toThrow('trusted Node runtime')
      await expect(child.kill()).rejects.toThrow('trusted Node runtime')
    }
    expect(mocks.start).not.toHaveBeenCalled()
    mocks.start.mockResolvedValue({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      completion: Promise.resolve({ code: 0, signal: null }),
      terminate() {},
    })
    const child = new ExternalProcess(
      { command: 'agent.exe', cwd: 'C:\\work', launch: { windowsNodeExecutable: 'C:\\runtime\\node.exe' } },
      () => {},
      () => {},
    )
    await child.ready
    expect(mocks.start.mock.calls[0]?.[1].nodeExecutable).toBe('C:\\runtime\\node.exe')
    await child.kill()
  })
})
