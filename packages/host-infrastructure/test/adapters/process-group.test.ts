import { afterEach, expect, it, vi } from 'vitest'

const { ps } = vi.hoisted(() => ({ ps: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: ps }))

import { stopProcessGroup } from '../../src/adapters/process-group.js'

afterEach(() => vi.restoreAllMocks())
it('counts only descendants in the owned group and reports cleanup refusal', () => {
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
