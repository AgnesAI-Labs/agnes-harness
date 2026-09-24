import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { windowsProcessIdentity } from '../src/adapters/process-identity-win32.js'

it('preserves all 64 bits of creation time and binds the PID', async () => {
  const query = () => '18446744073709551615'
  expect(await windowsProcessIdentity(42, { query })).toEqual({
    state: 'alive',
    startId: 'win32:42:18446744073709551615',
  })
  expect(await windowsProcessIdentity(43, { query })).not.toEqual(await windowsProcessIdentity(42, { query }))
})
it.each([0, -1, 1.5, NaN, Infinity, 4294967296])('refuses invalid PID %s before querying', async (pid) => {
  const query = vi.fn(() => null)
  expect((await windowsProcessIdentity(pid, { query })).state).toBe('unknown')
  expect(query).not.toHaveBeenCalled()
})
it.each(['', '0', '-1', '01', '1.5', '18446744073709551616', 'private data'])(
  'refuses malformed creation time %s',
  async (time) => {
    expect((await windowsProcessIdentity(42, { query: () => time })).state).toBe('unknown')
  },
)
it('only reports dead on confirmed nonexistence and keeps query errors unknown and sanitized', async () => {
  expect(await windowsProcessIdentity(42, { query: () => null })).toEqual({ state: 'dead' })
  const result = await windowsProcessIdentity(42, {
    query() {
      throw new Error('PRIVATE OS DETAILS')
    },
  })
  expect(result).toEqual({ state: 'unknown', reason: 'process identity unavailable' })
})
it.runIf(process.platform === 'win32')(
  'queries a stable self identity and distinguishes a real child before and after exit',
  async () => {
    const self = await windowsProcessIdentity(process.pid)
    expect(self.state).toBe('alive')
    expect(await windowsProcessIdentity(process.pid)).toEqual(self)
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    const exited = once(child, 'exit')
    try {
      await once(child, 'spawn')
      const pid = child.pid
      if (pid === undefined) throw new Error('child PID missing')
      const alive = await windowsProcessIdentity(pid)
      expect(alive.state).toBe('alive')
      expect(alive).not.toEqual(self)
      child.stdin.end()
      await exited
      expect(await windowsProcessIdentity(pid)).toEqual({ state: 'dead' })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
    }
  },
)
