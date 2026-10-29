import { afterEach, expect, it, vi } from 'vitest'

const { ps, fs } = vi.hoisted(() => ({ ps: vi.fn(), fs: { readdirSync: vi.fn(), readFileSync: vi.fn() } }))
vi.mock('node:child_process', () => ({ execFileSync: ps }))
vi.mock('node:fs', () => fs)

import { stopProcessGroup } from '../../src/adapters/process-group.js'

afterEach(() => {
  vi.restoreAllMocks()
  ps.mockReset()
  fs.readdirSync.mockReset()
  fs.readFileSync.mockReset()
})
it('counts only descendants in the owned group and reports cleanup refusal', () => {
  fs.readdirSync.mockImplementation(() => {
    throw Object.assign(new Error('no /proc'), { code: 'ENOENT' })
  })
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  ps.mockReturnValue('100 100 S\n101 100 S\n102 100 S\n103 100 Z\n200 200 S\n')
  expect(stopProcessGroup(100)).toBe(2)
  expect(kill).toHaveBeenLastCalledWith(-100, 'SIGKILL')
  ps.mockImplementationOnce(() => {
    throw new Error('ps unavailable')
  })
  expect(stopProcessGroup(100)).toBeUndefined()
  expect(kill).toHaveBeenLastCalledWith(-100, 'SIGKILL')
  kill.mockImplementation(() => {
    throw Object.assign(new Error('refused'), { code: 'EPERM' })
  })
  expect(() => stopProcessGroup(100)).toThrow('refused')
  kill.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  })
  expect(stopProcessGroup(100)).toBe(0)
})

it('counts the group from /proc on Linux, where minimal images ship no ps', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
  ps.mockImplementation(() => {
    throw Object.assign(new Error('spawnSync /bin/ps ENOENT'), { code: 'ENOENT' })
  })
  const stats: Record<string, string> = {
    '1': '1 (sleep) S 0 1 1 0',
    '100': '100 (sh) S 1 100 100 0',
    '101': '101 (python3 -u (x) y) S 1 100 100 0',
    '102': '102 (sleep) R 101 100 100 0',
    '103': '103 (defunct) Z 1 100 100 0',
    '200': '200 (node) S 1 200 200 0',
  }
  fs.readdirSync.mockReturnValue(['self', ...Object.keys(stats), '104'])
  fs.readFileSync.mockImplementation((path: string) => {
    const stat = stats[path.split('/')[2] ?? '']
    if (stat === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    return stat
  })
  expect(stopProcessGroup(100)).toBe(2)
  expect(kill).toHaveBeenLastCalledWith(-100, 'SIGKILL')
  expect(ps).not.toHaveBeenCalled()
  // An unreadable /proc falls back to ps rather than reporting nothing.
  fs.readdirSync.mockImplementation(() => {
    throw new Error('no procfs')
  })
  ps.mockReturnValue('100 100 S\n101 100 S\n')
  expect(stopProcessGroup(100)).toBe(1)
})
