import { PassThrough } from 'node:stream'
import { startWindowsJobProcess } from '@agnes/system-node/process-spawn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWindowsIsolatedCommand } from '../src/process-win32.js'

vi.mock('@agnes/system-node/process-spawn', () => ({ startWindowsJobProcess: vi.fn() }))
afterEach(() => vi.resetAllMocks())

describe('Windows isolation cancellation failures', () => {
  const options = { cwd: process.cwd(), env: process.env, timeoutMs: 5000, maxOutputBytes: 1024 }

  it('keeps a started child cleanup error when cancellation also occurred', async () => {
    const controller = new AbortController()
    const error = Object.assign(new Error('Job cleanup failed'), { code: 'E_JOB_CLEANUP_TIMEOUT' })
    vi.mocked(startWindowsJobProcess).mockImplementation(async () => {
      controller.abort()
      return {
        pid: 12345,
        terminate: vi.fn(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        completion: Promise.resolve({ code: null, signal: null, cancelled: true, error }),
      }
    })
    await expect(
      runWindowsIsolatedCommand('node', [], { ...options, signal: controller.signal }),
    ).rejects.toBe(error)
  })

  it('reports cancellation when a preflight rejection races it', async () => {
    const controller = new AbortController()
    vi.mocked(startWindowsJobProcess).mockImplementation(async () => {
      controller.abort()
      throw new Error('preflight failed')
    })
    await expect(
      runWindowsIsolatedCommand('missing-command', [], { ...options, signal: controller.signal }),
    ).rejects.toThrow('command aborted')
  })

  it('keeps a cleanup timeout when startup cancellation has not settled', async () => {
    const controller = new AbortController()
    const error = Object.assign(new Error('Job cleanup failed'), { code: 'E_JOB_CLEANUP_TIMEOUT' })
    vi.mocked(startWindowsJobProcess).mockImplementation(async () => {
      controller.abort()
      throw error
    })
    await expect(
      runWindowsIsolatedCommand('node', [], { ...options, signal: controller.signal }),
    ).rejects.toBe(error)
  })
})
